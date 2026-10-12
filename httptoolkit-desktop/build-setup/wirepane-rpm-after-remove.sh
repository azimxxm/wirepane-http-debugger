#!/bin/bash
# wirepane: the .rpm's after-remove script (build-setup/wirepane-builder.config.cjs). It's
# electron-builder's default one (templates/linux/after-remove.tpl) with upstream's upgrade check
# (scripts/post-uninstall-rpm.sh). electron-builder fills in the executable and folder names.

# rpm also runs this after an upgrade, once the new version is installed ($1 is then 1 or more).
# Removing the link and the AppArmor profile then would break the new version.
if [ "$1" -ge 1 ]; then
    exit 0
fi

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload the AppArmor profile that after-install added (Ubuntu 24+)
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
