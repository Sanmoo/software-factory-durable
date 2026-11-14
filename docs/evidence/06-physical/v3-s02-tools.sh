export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8
set -o pipefail
set -eu
apk add --no-cache openssl >/dev/null && openssl version
mkdir -p /workspace/fx06 && cd /workspace/fx06
printf '{"name":"fx06","private":true,"type":"module"}\n' > package.json
npm install --save-exact --no-audit --no-fund testcontainers@10 2>&1 | tail -2
node -e "const l=require('./package-lock.json');const t=l.packages['node_modules/testcontainers'];console.log('testcontainers',t.version,t.integrity)"
sha256sum package-lock.json
docker pull -q testcontainers/ryuk:0.11.0 | tail -1; docker image inspect --format '{{index .RepoDigests 0}}' testcontainers/ryuk:0.11.0
