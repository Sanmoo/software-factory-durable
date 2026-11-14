export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8
set -o pipefail
set +e
docker info --format 'driver={{.Driver}} root={{.DockerRootDir}}'; grep userland /etc/docker/daemon.json
docker pull -q node:22-alpine | tail -1; docker image inspect --format '{{index .RepoDigests 0}}' node:22-alpine
docker network create q06-net >/dev/null && echo net-created
docker run -d --rm --network q06-net --name q06-srv -p 18080:8080 node:22-alpine node -e "require('http').createServer((q,r)=>r.end('pub-ok')).listen(8080)" >/dev/null
sleep 3; printf 'publish: '; wget -q -T 5 -O - http://127.0.0.1:18080; echo " rc=$?"
printf 'c2c: '; docker run --rm --network q06-net node:22-alpine wget -q -T 5 -O - http://q06-srv:8080 2>/dev/null; echo " rc=$?"
docker stop q06-srv >/dev/null; docker network rm q06-net >/dev/null; echo own-cleaned
