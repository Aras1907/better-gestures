project('gnome-3-finger-drag', 'gnome-shell-extension',
  version: '1.0',
  license: 'MIT',
  meson_version: '>= 0.50.0',
  default_options: ['prefix=/usr'])

uuid = 'gnome-3-finger-drag@extension.org'
schema = 'org.gnome.shell.extensions.3-finger-drag'

# Install extension files
install_data(
  ['extension.js', 'prefs.js', 'metadata.json'],
  install_dir: join_paths(get_option('datadir'), 'gnome-shell', 'extensions', uuid)
)

# Install library files
install_subdir('lib', 
  install_dir: join_paths(get_option('datadir'), 'gnome-shell', 'extensions', uuid))

# Install schemas
install_data(
  ['schemas/' + schema + '.gschema.xml'],
  install_dir: join_paths(get_option('datadir'), 'glib-2.0', 'schemas')
)

# Compile schemas after installation
meson.add_install_script('glib-compile-schemas', 
  join_paths(get_option('datadir'), 'glib-2.0', 'schemas'))
