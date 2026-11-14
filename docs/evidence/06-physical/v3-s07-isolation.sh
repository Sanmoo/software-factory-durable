export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8
set -o pipefail
set +e
probe(){ printf '%-34s ' "$1"; if wget -q -T 5 -O /dev/null "$2" 2>/dev/null; then echo REACHED; else echo denied; fi; }
probe 'gateway 192.168.127.1:80' http://192.168.127.1/
probe 'rfc1918 10.0.0.1' http://10.0.0.1/
probe 'rfc1918 172.16.0.1' http://172.16.0.1/
probe 'rfc1918 192.168.1.1' http://192.168.1.1/
probe 'metadata 169.254.169.254' http://169.254.169.254/
probe 'host-lan 192.168.0.183' http://192.168.0.183/
probe 'public https example.com' https://example.com/
echo "== default-bridge container"; docker run --rm node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a sh -c "wget -q -T 5 -O /dev/null http://192.168.0.183/ && echo host-REACHED || echo host-denied; wget -q -T 5 -O /dev/null https://example.com/ && echo public-REACHED || echo public-denied" 2>&1 | grep -v WARNING
echo "== from container"
docker run --rm node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a sh -c 'for u in http://10.0.0.1/ http://169.254.169.254/ https://example.com/; do printf "%s " $u; wget -q -T 5 -O /dev/null $u 2>/dev/null && echo REACHED || echo denied; done' 2>&1 | grep -v WARNING
echo "== docker socket host?"; ls -l /run/docker.sock; ls /var/run/docker.sock 2>&1 | head -1
