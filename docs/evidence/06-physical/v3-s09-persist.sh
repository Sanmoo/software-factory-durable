export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8
set -o pipefail; set -eu
echo "== rootfs marker"; cat /var/tmp/q06-marker
echo "== apk package"; apk info -e openssl
echo "== git"; d=$(ls -d /workspace/fx06/git06-* | head -1); git -C $d rev-parse HEAD; git -C $d ls-files -s; git -C $d fsck --full && echo fsck-ok
echo "== npm/lock"; sha256sum /workspace/fx06/package-lock.json; ls /workspace/fx06/node_modules | wc -l; ls ~/.npm/_cacache | head -2
echo "== docker"; docker info --format 'driver={{.Driver}}'; docker images --digests --format '{{.Repository}}@{{.Digest}}' | sort
docker run --rm -v q06-persist:/data node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a cat /data/marker 2>&1 | grep -v WARNING
echo "== leftovers (own labels)"; docker ps -a --filter label=org.testcontainers=true --format '{{.ID}} {{.Status}}' | wc -l
echo "== testcontainers again after reboot"
cd /workspace/fx06
export FACTORY_06_IMAGE=node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
export RYUK_CONTAINER_IMAGE=testcontainers/ryuk@sha256:2eaec4fc2cf1f67eb6624d4463467ea8aac999a01b2ff74b5973e9a563b7c2b5
./docker06.sh 2>&1 | grep -E '^06 |Error' | tail -8
