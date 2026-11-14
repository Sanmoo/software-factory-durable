export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8
set -o pipefail
set -eu
cd /workspace/fx06
export FACTORY_06_IMAGE=node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
export RYUK_CONTAINER_IMAGE=testcontainers/ryuk@sha256:2eaec4fc2cf1f67eb6624d4463467ea8aac999a01b2ff74b5973e9a563b7c2b5
export DEBUG='testcontainers:containers,testcontainers:reaper'
./docker06.sh 2>&1 | grep -v '^\s*$' | tail -40
echo "== ryuk/labels after"; docker ps -a --filter label=org.testcontainers=true --format '{{.ID}} {{.Image}} {{.Status}} {{.Label "org.testcontainers.session-id"}}'
