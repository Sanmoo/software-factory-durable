export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8
set -o pipefail
set -eu
docker volume create q06-persist >/dev/null
docker run --rm -v q06-persist:/data node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a sh -c 'echo q06-volume-data-v1 > /data/marker && cat /data/marker'
docker images --digests --format '{{.Repository}}@{{.Digest}}' | sort
du -sh /var/lib/docker 2>/dev/null; df -h / /workspace | tail -2
ls /workspace/fx06/node_modules | wc -l; apk info -e openssl
echo "== persistence markers"; echo q06-rootfs-marker > /var/tmp/q06-marker; cat /var/tmp/q06-marker
d=$(ls -d /workspace/fx06/git06-* | head -1); git -C $d rev-parse HEAD; git -C $d ls-files -s
sha256sum /workspace/fx06/package-lock.json; ls ~/.npm/_cacache 2>/dev/null | head -2
