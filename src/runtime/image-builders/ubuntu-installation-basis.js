// The raw installed status is provenance, not release authority. The release owner
// must still bind and validate it against the exact construction/capture subject.
export const UBUNTU_INSTALLATION_BASIS_PATH = '/var/lib/devbridge/bootstrap/ubuntu-installation-basis.status';

const CAPTURE = `set -eu
target=$1
source="$target/var/lib/dpkg/status"
record="$target${UBUNTU_INSTALLATION_BASIS_PATH}"
parent="$target/var/lib/devbridge/bootstrap"
fail() { printf '%s\\n' "Ubuntu installation basis: $1" >&2; exit 1; }
[ -d "$target" ] && [ ! -L "$target" ] || fail 'target is not a direct directory'
for relative in var var/lib var/lib/dpkg var/lib/devbridge var/lib/devbridge/bootstrap; do
  entry="$target/$relative"
  [ ! -L "$entry" ] || fail 'directory indirection is unsupported'
  if [ -e "$entry" ]; then [ -d "$entry" ] || fail 'directory was replaced'; fi
done
[ -f "$source" ] && [ ! -L "$source" ] && [ -s "$source" ] || fail 'status is not a direct nonempty file'
[ "$(stat -c %h -- "$source")" = 1 ] || fail 'status has unexpected links'
if [ -e "$record" ] || [ -L "$record" ]; then
  [ -f "$record" ] && [ ! -L "$record" ] || fail 'record is not a direct file'
  [ "$(stat -c %h -- "$record")" = 1 ] || fail 'record has unexpected links'
  cmp -s -- "$source" "$record" || fail 'captured state differs; original record retained'
  exit 0
fi
umask 022
mkdir -p -- "$parent"
staging=$(mktemp "$parent/.ubuntu-installation-basis.XXXXXX")
cleanup() {
  result=$?
  trap - EXIT
  if ! rm -f -- "$staging"; then
    printf '%s\\n' 'Ubuntu installation basis: staging cleanup failed; evidence retained' >&2
    [ "$result" -ne 0 ] || result=1
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cat -- "$source" >"$staging"
cmp -s -- "$source" "$staging" || fail 'status changed during capture'
chmod 0444 -- "$staging"
ln -T -- "$staging" "$record"
`;

export function ubuntuInstallationBasisCaptureCommand(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target === '/'
      || /[\\\u0000-\u001f\u007f]/u.test(target)
      || target.split('/').slice(1).some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError('Ubuntu installation basis target must be a direct absolute guest path');
  }
  return Object.freeze(['sh', '-c', CAPTURE, 'devbridge-ubuntu-installation-basis', target]);
}
