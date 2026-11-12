# 03 — proposta final limitada à persistência dos paths e mounts

**AUTORIZADO explicitamente e EXECUTADO em2026-11-12.** Fonte limpa1c99baf,
exatos2bootsX3 e publicremove próprio após gates/evidência/cessação; orçamento
consumido, nenhum retry/terceiroboot implícito. [Resultado X3](03-x3-persistence-and-storage-qualified.md)
e [reconciliação técnica](03-acceptance-reconciliation.md) registram limites e
avaliação humana ainda separada; não é aceite automático nem autorização de merge.

O escopo43 anterior executou seus dois boots e cleanup de W3; não há terceira
tentativa ou reserva reutilizável. Módulos locais em
[storage/smoke](03-storage-observation-and-guest-smoke-local.md) receberam a prova
na composição efetiva, não nova investigação de imagem. Texto do escopo concedido:

## Concessão concedida (histórico)

- UM ambiente NOVO, root curto sugerido `/home/sanmoo/software-factory-test/x3`,
  somente se ausente. Nunca adotar/recriar os W3 já removidos ou recursos antigos.
- Até DOIS boots SEQUENCIAIS do MESMO ambiente/disco, max1VMativa, cada2048MiB/
  2CPU/40GiBvirtual; startup30s/grace30s/exec10s/console none/debugfalse inalterados.
- Pin congelado4b6e90d356b2f93a2f7ec014f2778c1ce2fea8cfd8a19894fdb8112aa95038c1.
  Sem nova imagem/kernel/initramfs/SDK/backend, APKinstall ou rede/modelo/GH/creds.
- Zero nova injeção de falha, reparo, promoção de disco ou hostmount/sudo/install.
- Somente stop/remove dos próprios operacionais NOVOS, após evidências necessárias
  preservadas fora dos alvos, syntheticWorkcancelled e cessação correlacionada.
- Falha/inconclusão interrompe boots/cleanup seguintes; finally solicita stop só
  dos novos próprios e guarda restantes. Sem retry/terceiro boot/fallback/tuning.

Fonte exata foi1c99baf1df8d4acad02d2e2dc6c1444c4d382d69, incluindo módulos
revisados, registrada no intent exclusivo antes de efeitos. Orçamento retido80GiB/pressão79GiB/piso4GiB do root
inclui todas as evidências antigas; observar espaço não libera UNKNOWN/noRetry.

## O que fecha a prova restante

1. Preflight público de integridade/configuração, memória/espaço e raiz ausente.
   Prepare único, sem SDK irrestrito fora do adapter, sem script de caller/worker.
2. Start1 pelo público deve confirmar operacional após executar o smoke FIXO do
   produto: Alpine/Docker-vfs, stamps em oito paths e write/rename/alias absoluto
   guest/read pelos DOIS mounts. Não criar exceção/flag de qualificação para isso.
3. Observe público expõe storage: virtual real do header40GiB separado de espaço
   físico alocado, uso workspace/artifacts e freebytes/configfloor quando medidos;
   unknown/unavailable não é zero. Essa observação não substitui a cessação.
4. Stop1 pelo público, guestfinalizationobserved e cessação INDEPENDENTE por
   identidade privada + HostBoot/namespaces/full-rootcgroup2/controllers/manager/
   invocação própria/grupo realmente ausente ou vazio. DefaultsGC/PID/ACK/close
   isolados não são prova de cessação, causa ou parada graciosa.
5. Snapshot privado read-only após cessação: qco/e2fsck-f-n0/geometria40GiB e
   original estável durante inspeção. Ler os stamps de /root,/tmp,/var/tmp,
   /var/cache,/var/log,/var/cache/apk no snapshot e os stamps /workspace,/artifacts
   nos arquivos host que o GUEST acabou de gravar pelo FUSE. Todos8devem ter SHA
   do valor env|BOOT1, não um hostseed. Amostrar engine-id/configDaemon/world/repos/
   installedAPK sem capturar rawID/chaves/corpos. Falha bloqueia start2.
6. Somente com TODOS primeiros gates aprovados: start2 público mesmo env/disco,
   sem reprepare/reclone/reseed. Novo boot/VMM com mesma configuração/pin, smoke
   fixo roda outra vez e confirma alias-routing; markers existentes não são
   sobrescritos. Nenhum teste altera filesystem/template para fabricar verde.
7. Stop2/cessação/checks read-only e observar os MESMOS8stamps com valor de BOOT1,
   MAIS mesmas amostras de pacotes/config/cache/daemon-state. Se marker foi perdido
   e recriado pelo readiness terá BOOT2 e a prova FALHA, não uma falsa persistência.
8. Preservar dados/evidências necessárias e histórico, publicremove apenas novo
   ambiente após todosboots cessados; removed exige ausência física e correlação.
   Publicstorage absent é estado explícito, não zero do footprint total: arquivos
   retidos em snapshots/archives continuam consumindo espaço. Sem cleanup antigo.

## Não exigir nem fingir

Não é uma suíteGit/locks/Testcontainers/Ryuk/TLS06, nem PiSDK/modelo/roles/handoff05,
release32 ou piloto35. Também não é prova de integridade de todos dados, reparo
automático, tolerância futura a crash ou parada graciosa absoluta. Prova-se apenas
a persistência/roteamento exigida por03 com seu perfil atual, somada às provas
anteriores de owner-loss, isolamento e cleanup. Depois mapear os oito critérios,
sem elevar automaticamente o resultado do qualificador a aceite humano/merge.
