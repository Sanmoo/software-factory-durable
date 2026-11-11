# Ticket03 — diagnóstico t3: marcadores entregues, lifecycle reprovado

Autorização consumida: uma VM diagnóstica2GiB/2vCPU/40GiB virtual em root novo
`/home/sanmoo/software-factory-test/t3`, mesma imagem/pin960b256c..., sem retry,
fallback, agentes, credenciais, aumento de timeout ou gravação de console bruto.
Fonte executada: `c5c93771322f815285679a1f7bc79753c920cf6f`.
A [fonte dos marcadores](03-private-boot-markers.md) passou na revisão independente
única9a6d7806 e nos gates locais (62pass/1VMskip, compilação/build/arquitetura/lint).

## Resultado real

Preflight `t3-preflight-c5c9377.json`: assets íntegros, memória disponível7001575424B,
filesystem disponível595524214784B, socket106B; root inexistente e nenhum QEMU
listado. Isso não libera reservas históricas UNKNOWN.

Prepare passou. Environment:
`env-38f4c93bd9faf5c84beae8291aa860c5e69e60b66f78112cb4ac02ccd3646a48`.
Boot: `boot-6bc8ddcf-718d-4b39-b17f-4a261342659f`.
Witness real: PID2315867/startTicks94031621, kernel/initrd/disco próprios,
KVM/2048M/2CPU/CPUhost/machinemicrovm. Única alteração relevante de diagnóstico
no argv: serialstdio em vez de null; nenhuma outra imagem ou flag de workaround.

Start voltou a falhar em `vm-start / GUEST_READINESS_TIMEOUT`, público e no
failure.json privado. Não houve operacional/check Docker. Antes de stop já estava
parado; stop reconheceu cessação existente, não demonstrou parada ativa/graciosa.
`result.json`: `operationalBoot:false`, `activeBeforeStop:false`,
`qualifyingVmmWitness:true`, **`accepted:false`**, sem restart/removal.

## Sinal novo, sem conteúdo bruto

`boot-markers.json` real, correlacionado ao boot:

```json
{"version":1,"boot":"boot-6bc8ddcf-718d-4b39-b17f-4a261342659f","stages":["console-text-observed","acpi-text"],"callbacks":100,"oversized":0}
```

A entrega pelo SDK/VMM aconteceu e o registro permaneceu limitado a códigos e
contadores. Não se observou marcador de init do root/sandboxfs/pre-hook. Essa
lista **não prova** que esses estágios não executaram, que ACPI é a causa ou que
a captura cobre todo o console. Não há raw para reconstruir mensagens omitidas;
não se fabricaram marcadores adicionais retrospectivamente.

`manager-final.json`: mesma invocation442e63460272473c8875649e9a788f95 de started,
hostBoot conferido, namespaces cgroup4026531835/mount4026531832 correspondentes,
MainPID0/ControlGroup vazio, unit failed/exit-code/status1. Rodou07:00:52–07:01:25
UTC-03 em2026-11-11 (~33s). Cgroup exato ausente, hierarquia/controllers disponíveis
e nova observação pública confirmou cessação. MemoryPeak250589184B/CPU32883686000ns
são contadores do escopo, não qualificação de RAM guest/vCPU.
Disco, runtime, failed unit e todos os registros preservados. Uso físico observado
27608133632B<80GiB, sem liberação/remoção de recursos anteriores.

## Comparação estática com a prova antiga, sem executá-la

Foram lidos somente drivers/evidências preservados em `ticket03/build/` e
`ticket03/logs/`, e fonte do teste antigo **mantido em safety hold**. Nenhum driver
antigo foi importado/executado e nenhuma VM adicional foi iniciada.

O argv arquivado de `persistence-b.txt`, que executou comandos em dois boots,
também usa KVM, microvm, CPUhost,2048M/2CPU, serialstdio, mesmas opções básicas de
drive/dispositivos e mesmo append de kernel, exceto paths próprios. QEMU11.1.2 e
host7.1.9-arch1-2 também coincidem com a documentação antiga. Logo não se encontrou
um delta desses campos que justifique atribuir culpa a microvm/ACPI ou aplicar
acpi=off. A prova antiga continua sendo só composição SDK específica, sem Docker.

Entre initramfs antigo funcional e candidato:

- Ambos são LZ4 legado; tamanhos6164763B e6500096B, respectivamente.
- `/init` SHA-256 idêntico `f8ef27b23f799f545706c8ec39c143e249554727ce51d39e420c26d85e9b8e95`.
- BusyBox e loader musl são byte a byte iguais; kernel58 já era idêntico.
- Cinco módulos necessários (virtio_blk/ext4/jbd2/mbcache/crc16), após descomprimir
  gzip do antigo, são byte a byte iguais aos `.ko` do candidato. modules.builtin
  coincide. modules.dep difere, coerente com sufixos `.ko.gz` versus `.ko`.
- Isso não declara archives completos/metadata equivalentes. A primeira tentativa
  de extrair `./init` não casou o nome e produziu hash vazio; foi corrigida para
  o nome literal `init`, sem tratar hash vazio como equivalência de scripts.

O driver antigo usava startup60s; o atual30s. Não há tempos por boot recuperáveis
na unit/journal antigos consultados; não se assume que aumentar timeout corrige
nada. Não se reativou a unit antiga, nem se confundiu LoadState not-found com
prova de cessação/liberação de reserva.

## Próxima hipótese testável, não correção presumida

O sinal ainda não identifica a causa. Um ensaio diferencial poderá isolar **somente
o archive initramfs**: variante explicitamente declarada com o initramfs58 da
prova antiga, mantendo kernel58 idêntico e rootfs Docker-vfs novo/íntegro, demais
opções e timeout30s. Não é usar o rootfs antigo sem Docker como verde, misturar
versões silenciosamente ou fallback automático. Compatibilidade completa dessa
variante não está provada e precisa ser validada/qualificada.

Previsão: se essa diferença do archive for suficiente para explicar o problema,
o progresso/readiness mudará com todo o resto fixo; se não mudar, isso não libera
outra tentativa nem demonstra qual componente é culpado. Preparar tal variante e
executar outra VM requer decisão explícita, pois esta autorização fixou a imagem
960b256c... e já foi consumida. Nada da variante foi montado ou iniciado.

Causa, primeiro boot operacional, parada ativa/graciosa, persistência/restart/
filesystem growth/isolation/owner loss/tools/remove permanecem pendentes.
Instrumentação ainda é temporária: remover ativação ou resolver buffering SDK
antes de workers/integração. Ticket03 não aceito; integration/software-factory-mvp
permanece b591ec7, sem push ou cleanup.
