import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import type CopyousExtension from '../../extension.js';
import { registerClass } from '../common/gjs.js';
import {
	get_first_visible_child,
	get_last_visible_child,
	get_n_visible_children,
	get_next_visible_sibling,
	get_previous_visible_sibling,
} from '../misc/actor.js';
import { ClipboardItem } from './items/clipboardItem.js';
import { State, StatusItem } from './items/statusItem.js';
import { SearchChange, SearchQuery } from './searchEntry.js';

// How many items to insert into the container eagerly during bulk load.
// Items past this index are held in a deferred queue and inserted in idle
// batches after the dialog has been shown, so dialog.show() doesn't have to
// realize 400+ children synchronously on first open.
const INITIAL_VISIBLE_BATCH = 30;
const DEFERRED_BATCH_SIZE = 20;

@registerClass()
export class ClipboardScrollContainer extends St.BoxLayout {
	private readonly _statusItem: StatusItem;
	private readonly _ext: CopyousExtension;
	private _lastFocus: Clutter.Actor | null = null;
	private _lastQuery: SearchQuery | null = null;

	// Lazy-realize state: during bulk load, items past INITIAL_VISIBLE_BATCH go
	// into _deferred and are drained later via realizeDeferred().
	private _bulkLoading: boolean = false;
	private _bulkLoadCount: number = 0;
	private _deferred: ClipboardItem[] = [];
	private _deferredIdleId: number = -1;

	constructor(ext: CopyousExtension) {
		super({
			style_class: 'clipboard-item-list',
			x_align: Clutter.ActorAlign.START,
			x_expand: false,
		});

		this._ext = ext;
		this._statusItem = new StatusItem(ext);
		this.updateVisible();
	}

	public beginBulkLoad(): void {
		this._bulkLoading = true;
		this._bulkLoadCount = 0;
	}

	public endBulkLoad(): void {
		this._bulkLoading = false;
	}

	override destroy(): void {
		if (this._deferredIdleId >= 0) {
			GLib.source_remove(this._deferredIdleId);
			this._deferredIdleId = -1;
		}
		this._deferred.length = 0;
		super.destroy();
	}

	public realizeDeferred(): void {
		if (this._deferredIdleId >= 0) return; // drain already in progress
		if (this._deferred.length === 0) return;

		/* DEBUG-ONLY */ const _tStart = GLib.get_monotonic_time();
		/* DEBUG-ONLY */ const _initialCount = this._deferred.length;

		this._deferredIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
			const batch = this._deferred.splice(0, DEFERRED_BATCH_SIZE);
			for (const item of batch) {
				this.insertOrMoveItem(item, true);
			}
			if (this._deferred.length === 0) {
				this._deferredIdleId = -1;
				/* DEBUG-ONLY */ const elapsed = (GLib.get_monotonic_time() - _tStart) / 1000;
				/* DEBUG-ONLY */ this._ext.logger.log(
					/* DEBUG-ONLY */ `[perf] realizeDeferred: ${_initialCount} items in ${elapsed.toFixed(0)}ms`,
				);
				return GLib.SOURCE_REMOVE;
			}
			return GLib.SOURCE_CONTINUE;
		});
	}

	private updateVisible() {
		const n = get_n_visible_children(this);
		if (n === 0) {
			this.add_child(this._statusItem);
			this.x_align = Clutter.ActorAlign.CENTER;
			this.x_expand = true;

			if (this.get_n_children() === 1) {
				this._statusItem.state = State.Empty;
			} else {
				this._statusItem.state = State.NoResults;
			}
		} else if (n >= 2 && this._statusItem.get_parent() !== null) {
			this.remove_child(this._statusItem);
			this.x_align = Clutter.ActorAlign.START;
			this.x_expand = false;
		}

		this.updatePseudoclasses();
	}

	private removePseudoclasses(): void {
		(get_first_visible_child(this) as St.Widget | null)?.remove_style_pseudo_class('first-child');
		(get_last_visible_child(this) as St.Widget | null)?.remove_style_pseudo_class('last-child');
	}

	private updatePseudoclasses(): void {
		(get_first_visible_child(this) as St.Widget | null)?.add_style_pseudo_class('first-child');
		(get_last_visible_child(this) as St.Widget | null)?.add_style_pseudo_class('last-child');
	}

	private nextFocus(child: Clutter.Actor, animate: boolean = true): void {
		if (child.get_parent() !== this) return;

		const newFocus = get_next_visible_sibling(child) ?? get_previous_visible_sibling(child);
		if (newFocus && newFocus !== this._statusItem) {
			this.focusChild(newFocus, animate);
		} else {
			// Navigate to the search entry
			global.focus_manager.get_group(this).grab_key_focus();
		}
	}

	public focusChild(child: Clutter.Actor, animate: boolean = true): void {
		if (child.get_parent() !== this) return;

		this._lastFocus = child;
		child.grab_key_focus();
		this.scrollToChild(child, animate);
	}

	public scrollToFocus(animate: boolean = true): void {
		for (const child of this.get_children()) {
			if (child.has_key_focus()) {
				this._lastFocus = child;
				this.scrollToChild(child, animate);
				return;
			}
		}
	}

	public scrollToChild(child: Clutter.Actor, animate: boolean = true): void {
		if (child.get_parent() !== this) return;

		const box = child.get_allocation_box();
		let adjustment: St.Adjustment;
		let value: number;
		if (this.orientation === Clutter.Orientation.HORIZONTAL) {
			adjustment = this.hadjustment;
			value = box.x1 + box.get_width() * 0.5 - adjustment.page_size * 0.5;
		} else {
			adjustment = this.vadjustment;
			value = box.y1 + box.get_height() * 0.5 - adjustment.page_size * 0.5;
		}

		if (this.text_direction === Clutter.TextDirection.RTL) {
			value = adjustment.get_upper() - adjustment.page_size - value;
		}

		if (animate) {
			adjustment.ease(value, { duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
		} else {
			adjustment.value = value;
		}
	}

	public addItem(item: ClipboardItem): void {
		// During bulk load (initEntryTracker), only the first INITIAL_VISIBLE_BATCH
		// items get inserted into the container synchronously. The rest are
		// queued in _deferred and drained later via realizeDeferred() so that
		// dialog.show()'s realize cascade doesn't touch hundreds of children at
		// once. Entries arrive newest-first (MemoryDatabase.entries() sorts by
		// datetime desc), so the newest 30 stay visible immediately.
		if (this._bulkLoading && this._bulkLoadCount >= INITIAL_VISIBLE_BATCH) {
			this._deferred.push(item);
		} else {
			this.insertOrMoveItem(item);
		}
		if (this._bulkLoading) this._bulkLoadCount++;

		// Move item when datetime changes — also moves deferred items into the
		// container if their datetime changes before realizeDeferred drains them.
		item.entry.connect('notify::datetime', () => this.insertOrMoveItem(item, false));

		// Delete item when deleted
		item.entry.connect('delete', () => this.removeItem(item));

		// Update search only when properties used by search can change.
		item.entry.connect('notify::content', () => this.updateSearch(item));
		item.entry.connect('notify::pinned', () => this.updateSearch(item));
		item.entry.connect('notify::tag', () => this.updateSearch(item));
		item.entry.connect('notify::type', () => this.updateSearch(item));
		item.entry.connect('notify::metadata', () => this.updateSearch(item));
		item.entry.connect('notify::title', () => this.updateSearch(item));
	}

	private insertOrMoveItem(item: ClipboardItem, search: boolean = true): void {
		this.removePseudoclasses();

		if (item.get_parent() === this) this.remove_child(item);

		let i = 0;
		for (const c of this.get_children()) {
			if (c instanceof ClipboardItem && c.entry.datetime.compare(item.entry.datetime) <= 0) {
				this.insert_child_at_index(item, i);
				break;
			}
			i++;
		}

		if (i === this.get_n_children()) {
			this.add_child(item);
		}

		if (search && this._lastQuery) {
			this.updateSearch(item);
		} else {
			this.updateVisible();
		}
	}

	public clearItems(): void {
		let focus = false;
		for (const child of this.get_children()) {
			if (child instanceof ClipboardItem) {
				focus ||= child.has_key_focus();
				this.remove_child(child);
			}
		}
		this.updateVisible();

		if (focus) {
			// Navigate to the search entry
			global.focus_manager.get_group(this).navigate_focus(this, St.DirectionType.UP, true);
		}
	}

	public removeItem(child: ClipboardItem): void {
		if (child.get_parent() !== this) return;

		const hasKeyFocus = child.has_key_focus();
		let newFocus = null;
		if (hasKeyFocus) {
			newFocus = get_next_visible_sibling(child) ?? get_previous_visible_sibling(child);
		}

		this.remove_child(child);
		this.updateVisible();

		if (hasKeyFocus) {
			if (newFocus && newFocus !== this._statusItem) {
				this.focusChild(newFocus);
			} else {
				this._lastFocus = null;

				// Navigate to the search entry
				global.focus_manager.get_group(this).navigate_focus(this, St.DirectionType.UP, true);
			}
		}
	}

	public selectItem(index: number): boolean {
		let i = 0;
		for (const child of this.get_children()) {
			if (child instanceof ClipboardItem && child.visible) {
				if (i === index) {
					this.focusChild(child);
					return true;
				}

				i++;
			}
		}

		return false;
	}

	public selectNextItem() {
		let focusChild: ClipboardItem | null = null;

		for (const child of this.get_children()) {
			if (focusChild === null && child instanceof ClipboardItem && child.visible) {
				focusChild = child;
			}

			if (child.has_key_focus()) {
				this.nextFocus(child);
				return;
			}
		}

		if (focusChild !== null) {
			this.focusChild(focusChild);
		}
	}

	public search(query: SearchQuery): void {
		// Copy search query, but with SearchChange.Different to always force re-search
		this._lastQuery = query.withChange(SearchChange.Different);

		this.removePseudoclasses();
		let focusChild: ClipboardItem | null = null;
		let firstVisible: ClipboardItem | null = null;
		for (const child of this.get_children()) {
			if (child instanceof ClipboardItem) {
				const hasFocus = child.has_key_focus();
				child.search(query);
				if (hasFocus) focusChild = child;
				if (child.visible && firstVisible === null) firstVisible = child;
			}
		}
		this.updateVisible();

		if (focusChild && focusChild.visible) {
			this.focusChild(focusChild, false);
		} else if (this._lastFocus && this._lastFocus.visible) {
			this.scrollToChild(this._lastFocus, false);
		} else if (firstVisible !== null) {
			this.focusChild(firstVisible, false);
		}
	}

	private updateSearch(item: ClipboardItem): void {
		if (!this._lastQuery) return;

		const hasKeyFocus = item.has_key_focus();
		this.removePseudoclasses();
		item.search(this._lastQuery);
		this.updateVisible();
		if (hasKeyFocus && !item.visible) this.nextFocus(item, false);
	}

	public activateFirst(): void {
		const first = get_first_visible_child(this);
		if (first instanceof St.Button) {
			first.vfunc_clicked(1);
		}
	}

	override vfunc_navigate_focus(from: Clutter.Actor | null, direction: St.DirectionType): boolean {
		// Navigation from the search entry
		if (from?.get_parent() !== this) {
			// If tab navigation is used, then focus on first or last child
			if (direction === St.DirectionType.TAB_FORWARD || direction === St.DirectionType.TAB_BACKWARD) {
				this._lastFocus = null;
				const child =
					direction === St.DirectionType.TAB_BACKWARD
						? get_last_visible_child(this)
						: get_first_visible_child(this);
				if (child !== this._statusItem) {
					this._lastFocus = child;
				}
			}

			// If the last focus is null or not visible, then focus the first visible child
			if (this._lastFocus === null || !this._lastFocus.visible || this._lastFocus.get_parent() !== this) {
				this._lastFocus = null;
				const child = get_first_visible_child(this);
				if (child !== this._statusItem) {
					this._lastFocus = child;
				}
			}

			// Navigate to the search entry
			if (!this._lastFocus) return Clutter.EVENT_PROPAGATE;

			this._lastFocus.grab_key_focus();
			this.scrollToChild(this._lastFocus);
			return Clutter.EVENT_STOP;
		}

		const first = get_first_visible_child(this);
		const last = get_last_visible_child(this);
		if (this.orientation === Clutter.Orientation.HORIZONTAL) {
			// If up or shift tab navigation then focus the search entry
			if (direction === St.DirectionType.UP) {
				this._lastFocus = from;
				// Navigate to the search entry
				return Clutter.EVENT_PROPAGATE;
			}

			// Ignore down navigation
			if (direction === St.DirectionType.DOWN) {
				return Clutter.EVENT_STOP;
			}
		} else {
			// If on the first child then focus the search entry
			if (from === first && direction === St.DirectionType.UP) {
				this._lastFocus = from;
				// Navigate to the search entry
				return Clutter.EVENT_PROPAGATE;
			}

			// If on the last child then focus on footer
			if (from === last && direction === St.DirectionType.DOWN) {
				this._lastFocus = from;
				return Clutter.EVENT_PROPAGATE;
			}

			// Ignore left and right navigation
			if (direction === St.DirectionType.LEFT || direction === St.DirectionType.RIGHT) {
				return Clutter.EVENT_STOP;
			}
		}

		// If on first child and shift tab navigation then focus the search entry
		if (from === first && direction === St.DirectionType.TAB_BACKWARD) {
			this._lastFocus = from;
			// Navigate to the search entry
			return Clutter.EVENT_PROPAGATE;
		}

		// If on last child and tab navigation then focus the footer
		if (from === last && direction === St.DirectionType.TAB_FORWARD) {
			this._lastFocus = from;
			// Navigate to footer
			return Clutter.EVENT_PROPAGATE;
		}

		// Otherwise map navigation to tab navigation due to weird behavior for a larger number of items
		const tabDirection =
			direction === St.DirectionType.TAB_FORWARD ||
			direction === St.DirectionType.RIGHT ||
			direction === St.DirectionType.DOWN
				? St.DirectionType.TAB_FORWARD
				: St.DirectionType.TAB_BACKWARD;
		const res = super.vfunc_navigate_focus(from, tabDirection);
		this.scrollToFocus();
		return res;
	}

	override vfunc_map(): void {
		this._lastFocus = null;
		this.hadjustment.value = 0;
		this.vadjustment.value = 0;

		super.vfunc_map();
	}
}
