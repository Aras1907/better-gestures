project('better-gestures',
  version: '1.2.0',
  license: 'MIT',
  meson_version: '>= 0.57.0',
  default_options: ['prefix=/usr'])

# A system-wide install, for distribution packages. The extension is plain
# JavaScript, so nothing here depends on the CPU architecture.

uuid = 'better-gestures@extension.org'
schema = 'org.gnome.shell.extensions.better-gestures'
extension_dir = get_option('datadir') / 'gnome-shell' / 'extensions' / uuid

install_data(['extension.js', 'prefs.js', 'metadata.json'],
  install_dir: extension_dir)

install_subdir('lib', install_dir: extension_dir)

install_data('schemas' / schema + '.gschema.xml',
  install_dir: get_option('datadir') / 'glib-2.0' / 'schemas')

import('gnome').post_install(glib_compile_schemas: true)
