import Adw from 'gi://Adw';

import { gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import Preferences from '../../../prefs.js';
import { registerClass } from '../../common/gjs.js';

@registerClass()
export class VersionSettings extends Adw.PreferencesGroup {
	constructor(prefs: Preferences) {
		const version =
			prefs.metadata['version-name']?.toString() ?? prefs.metadata['version']?.toString() ?? _('Unknown');

		super({
			title: _('Version'),
		});

		this.add(
			new Adw.ActionRow({
				title: version,
				subtitle: _('Installed build'),
				activatable: false,
			}),
		);
	}
}
