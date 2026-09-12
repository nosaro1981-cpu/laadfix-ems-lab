#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run dit script als root." >&2
  exit 1
fi

: "${DIAG_FTP_PASSWORD:?Stel DIAG_FTP_PASSWORD in}"
: "${PUBLIC_IP:?Stel PUBLIC_IP in}"

DIAG_FTP_USER="${DIAG_FTP_USER:-diagnostics}"
FTP_PORT="${FTP_PORT:-2121}"
PASV_MIN_PORT="${PASV_MIN_PORT:-30000}"
PASV_MAX_PORT="${PASV_MAX_PORT:-30009}"
FTP_ROOT="/srv/laadfix-diagnostics"

[[ "$DIAG_FTP_USER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || { echo "Ongeldige gebruikersnaam" >&2; exit 1; }
[[ "$FTP_PORT" =~ ^[0-9]+$ && "$PASV_MIN_PORT" =~ ^[0-9]+$ && "$PASV_MAX_PORT" =~ ^[0-9]+$ ]] || { echo "Ongeldige poort" >&2; exit 1; }

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y vsftpd ufw

if ! id "$DIAG_FTP_USER" >/dev/null 2>&1; then
  useradd --create-home --home-dir "$FTP_ROOT" --shell /usr/sbin/nologin "$DIAG_FTP_USER"
fi
printf '%s:%s\n' "$DIAG_FTP_USER" "$DIAG_FTP_PASSWORD" | chpasswd
install -d -m 0750 -o "$DIAG_FTP_USER" -g "$DIAG_FTP_USER" "$FTP_ROOT"

cat >/etc/vsftpd.conf <<EOF
listen=YES
listen_ipv6=NO
listen_port=${FTP_PORT}
anonymous_enable=NO
local_enable=YES
write_enable=YES
local_umask=022
chroot_local_user=YES
allow_writeable_chroot=YES
local_root=${FTP_ROOT}
pasv_enable=YES
pasv_address=${PUBLIC_IP}
pasv_min_port=${PASV_MIN_PORT}
pasv_max_port=${PASV_MAX_PORT}
connect_from_port_20=NO
xferlog_enable=YES
log_ftp_protocol=YES
dual_log_enable=YES
use_localtime=YES
seccomp_sandbox=NO
ssl_enable=NO
pam_service_name=vsftpd
EOF

grep -qxF /usr/sbin/nologin /etc/shells || echo /usr/sbin/nologin >>/etc/shells

ufw allow "${FTP_PORT}/tcp"
ufw allow "${PASV_MIN_PORT}:${PASV_MAX_PORT}/tcp"
systemctl enable --now vsftpd
systemctl restart vsftpd

echo "LaadFix diagnose-FTP luistert op poort ${FTP_PORT}."
