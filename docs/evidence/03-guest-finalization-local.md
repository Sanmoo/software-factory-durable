# 03 — finalização do guest: correção local, hardware ainda pendente

Continuação após u3, sem nova VM, alteração da imagem congelada4b6e ou execução
de guest script no host. Destino integration/software-factory-mvp/b591 mantido.

## Repro e diagnóstico

O perfil inicia dockerd diretamente no hook, antes de exec sandboxd. O adapter
usava `docker ps -q | xargs -r docker stop; rc-service docker stop; sync`.
Inspeção read-only do rootfs APK real: `/usr/bin/dockerd` presente, OpenRC e
rc-service ausentes. Esse é um comando incompatível confirmado; não preservamos
o exit code de finalização de u3, portanto não afirmamos causa exclusiva daquela
execução. O pipeline também mascarava possível falha de docker-ps.

Seam já usada/aprovada: entrypoint real do adapter, fronteiras externas SDK,
manager e filesystem dobradas; sem fake do módulo de produto. A fixture chega a
operational real do produtor antes de invocar SOMENTE o callback SIGTERM recém
registrado. Não envia sinal OS, não cria VMM/unit, spawn de VMM proibido.

Loop executado RED: build + node --test --test-name-pattern='operational adapter
finalizes' dist/test/sandbox/sandbox-adapter-diagnostics.test.js. Antes da correção,
1fail: audit profile-ready/stop-request/guest-finalize/guest-command-missing/close,
sem guest-synced; double externo retorna127 quando chamado serviço ausente.
Após correção, GREEN1. Esse loop captura a incompatibilidade de chamada, não
interpreta a shell Alpine nem qualifica hardware.

## Correção

Guest-only command usa pidfile do daemon direto, PID numérico maior que1,
readlink de exe dockerd e identidade de starttime em `/proc/PID/stat`. Lista
containers por substituição de comando fail-closed, desativa globbing e valida
IDs hex antes de docker-stop. Revalida daemon antes de TERM, aguarda estado
terminal ou desaparecimento da identidade original, depois sync. Não usa
pkill/prefix kill, serviço OpenRC, outro daemon/backend/flag de worker.

Revisão independente única fb1b7c27 encontrou P1: kill-0 permanece verdadeiro
para zombie. A fonte sandboxd inspecionada pelo reviewer espera filhos de exec,
não demonstra reap geral do dockerd herdado; hipótese de zombie é relevante.
Corrigido diretamente: snapshot validado de stat/starttime reconhece Z/X ou PID
reutilizado como término da identidade original, observação inesperada falha.
Não foi aberta cadeia de revisão. Não há confirmação de reaping do binário na
VM nem teste de execução real da shell sob estes testes locais.

AbortSignal compartilhado pelo comando limita a80% da grace do manager, deixando
margem para publicação/close (sem teorema de duração de fsync/SDK). stdout/stderr
são ignorados, não logs de conteúdo guest. Saída0 tenta publicar guest-synced
com file+directory sync antes de memoized close; qualquer erro/nonzero/abort/falha
de escrita segue para close sem transformar falha em finalização bem-sucedida.
Nenhum novo campo público. StopResult segue terminationunconfirmed/forced:
marcador observado não é prova de parada graciosa, filesystem desmontado ou
cessação. Essa última permanece independente por manager/host/NS/cgroup.

## Cobertura e limites

Seis casos de produtor: success, concurrent (um exec/close), nonzero, execfailure,
AbortSignal real800ms e evidence-write-failure. Quatro consumidores públicos
stop: marker válido/missing/foreignboot/extrafields, sempre sem inventar graceful
ou vazar canário. Casos de fronteira não simulam interpretação integral do script;
`sh -n` apenas verifica sintaxe, nunca executa o comando no host. O P1 de zombie
foi corrigido por evidência de semântica Linux/fonte; não alegar teste operacional
de um zombie real. Existentes casos de startup/console/close retidos.

Gates finais:73 casos,72pass/1VMskip/0fail (~12.23s), strict compile/build,
arquitetura/ESLint65módulos274dependências e diff-check. Commit no histórico
desta branch. Sem hardware novo,
sem repetir u3, sem promover guestFinalization para observed retroativamente.
Ainda falta um ensaio real fechado de finalização e filesystem/restart. Nenhuma
outra VM autorizada nesta rodada. Ticket03 permanece incompleto, sem integração,
push ou cleanup de recursos históricos. Console/debug temporários ainda não são
liberados para workers; buffering serial do SDK continua uma limitação conhecida.
