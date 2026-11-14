export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8
set -o pipefail
set -eu
cd /workspace/fx06
./git06.sh 2>&1 | tail -6
