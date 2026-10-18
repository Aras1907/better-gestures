UUID = gnome-3-finger-drag@extension.org
EXTENSION_DIR = ~/.local/share/gnome-shell/extensions/$(UUID)

zip:
	@echo "Creating extension zip..."
	@rm -f $(UUID).shell-extension.zip
	gnome-extensions pack . --extra-source=lib --extra-source=schemas

install: zip
	@echo "Installing extension..."
	gnome-extensions install $(UUID).shell-extension.zip --force
	@mkdir -p $(EXTENSION_DIR)/schemas
	@cp schemas/org.gnome.shell.extensions.3-finger-drag.gschema.xml $(EXTENSION_DIR)/schemas/
	@glib-compile-schemas $(EXTENSION_DIR)/schemas/

uninstall:
	@echo "Uninstalling extension..."
	gnome-extensions uninstall $(UUID) 2>/dev/null || true
	@rm -rf $(EXTENSION_DIR)

enable:
	gnome-extensions enable $(UUID)
	@echo "Extension enabled. Restart session if needed."

disable:
	gnome-extensions disable $(UUID)

clean:
	@rm -f $(UUID).shell-extension.zip
	@rm -f schemas/*.gschema.compiled

.PHONY: zip install uninstall enable disable clean
