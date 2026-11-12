# 03 — proposta fechada para owner-loss, isolamento e remoção reais

**PENDENTE DE AUTORIZAÇÃO ESPECÍFICA. Nenhuma VM/sinal/remoção deste plano executada.**
Os dois boots v3 estão consumidos. Este documento não amplia aquela concessão.
Fonte: commit que inclui este plano, worktree limpo; registrar OID exato antes de
qualquer efeito. Sem nova imagem/SDK/flags/timeouts de startup ou experiência de
initramfs. Integração03 continua bloqueada, destino b591ec7 intocado.

## Evidência existente e fronteiras ainda não provadas

- v3: dois boots KVM sequenciais de mesmo ambiente/disco, ext4real40GiB,
  Dockerengine-id persistente, guestfinalizationobserved e cessação independente.
  Não prova dois ambientes ativos nem perda do owner; terminationunconfirmed.
- remove: testes públicos de autorização/cesação/partials/retry/barreiras e
  retenção de histórico. Manager dobrado; não é remoção pós-VM real.
- RealFS: provider e FsRpcService REAIS, filesystem host REAL, entrypoint real,
  VM dobrada. Escape de metadata por ancestor symlink reproduzido e corrigido;
  dois mounts próprios, quatro zonas negativas, FDwrite/read/reopen real. Não
  prova kernel/FUSE aliases executando no guest nem hardware entre duas VMs.
- storage: falta de espaço simulada APENAS em statfs externo selecionado,
  discos reais para prepare/start. Não enche host nem prova ENOSPC de VM ativa.

Registrar esses níveis separadamente na matriz V-02/V-12/V-14. Não transformar
review/gates verdes em prova da fronteira substituída. Ferramentas/projeções de
workers de06 não serão contornadas por CLI/SDK externo ou seam privado de teste.

## Concessão solicitada — limites máximos, sem obrigação de gastar

1. **Dois ambientes NOVOS A/B**, root novo curto sugerido
   `/home/sanmoo/software-factory-test/w3`, apenas se ausente. Nunca adotar recursos
   existentes. IDs de Work de qualificação próprios, sem Work/GitHub/modelo real.
2. **Até três boots totais:** A1, B1 e condicional A2. Máximo dois simultâneos;
   cada VM2GiB/2vCPU/40GiBvirtual, agregado configurado4GiB/4vCPU. Esses valores
   não são promessa de quota total do host/serviço.
3. **Uma injeção de falha:** SIGKILL somente no MainPID do OWNER de A1, via
   manager USER e unit exata validada (não PID do VMM, glob, PID sozinho ou
   processo do operador). Antes: owner/boot/InvocationID/exe/cmdline/startticks/
   namespaces/cgroup esperado e estado do manager correlacionados e estáveis.
4. **Remoção real somente dos recursos operacionais desses A/B novos**, pela
   Sandbox pública, após declaração host de testWorkcancelled e evidência
   necessária copiada/durável fora dos diretórios removíveis. Não cancela ticket
   ou Trabalho real, não libera UNKNOWN histórico. Histórico lógico preservado.
5. Autoriza observe/stop de encerramento dos próprios A/B caso o cenário falhe;
   não autoriza sinais/remoção de quaisquer recursos anteriores ou terceiros.

Perfil fixo x86_64/QEMU/KVM/Alpine/Docker-vfs, pin
`4b6e90d356b2f93a2f7ec014f2778c1ce2fea8cfd8a19894fdb8112aa95038c1`.
Console none/debugfalse/sem logger; startup30s/grace30s inalterados. Sem TCG,
mount host, sudo/install/download, worker flags, repo/credencial/modelo/GitHub,
reparo de disco, novo bootstrap ou boot substituto para falha/inconclusão.

## Sequência e gates

0. Preflight read-only de integridade, capacidade e recursos atuais; conservar
   reservas UNKNOWN/noRetry, orçamento80GiB/pressão79GiB/piso4GiB do root de teste.
   Espaço observado não é reserva e inventário não é cessação universal.
1. Prepare A/B pelo contrato público, startA1; somente operacional/ativo/profile
   válido permite startB1. Identidades VMM/units/runtimes/discos distintos e
   ambos ativos; provas não dependem apenas de PID, ACK ou ausência de unit.
2. Falha específica do ownerA1. Observe/stop público sem reaproveitar handle SDK
   do proprietário morto. Correlacionar manager + host/namespaces + hierarquia
   cgroup full-root e cessação do escopo A1. B1 deve permanecer ativo, mesma
   identidade e recursos. Sem inferir parada graciosa pela falha do owner.
3. Só após cessaçãoA1, qcow2check/fscke2fsck-f-n/geometry e snapshot privado
   read-only sem mutar disco original. Falha/dirty/corrupção/unknown INTERROMPE
   A2, preserva candidatos, sem fsckrepair/retry. Capturar hash de engine-id
   apenas, nunca rawID/keys. Snapshot e metadata têm origem imutável verificada.
4. Se TODOS os gates passam, startA2 pelo contrato público no MESMO ambiente/
   disco, sem reprepare/recriação. Novo boot/VMM, B1 ainda ativo. Parar A2 pelo
   público, confirmar cessação independente; checks read-only e engine-id
   preservado entre A1/A2. Não fabricar graceful quando resultado é unconfirmed.
5. Copiar evidências necessárias antes de cleanupA; remover A pelo público com
   evidência/Workcancelled confirmados. Conferir resultados por recurso e
   observação removed com ausência efetiva, registros/histórico preservados;
   B1 deve CONTINUAR ativo/mesma identidade após cleanupA.
6. Parar B1, confirmar cessação independente, preservar evidências e remover
   somente B pelo mesmo contrato. Resultado parcial não é removed; já removidos
   são registrados, restantes preservados e nenhuma limpeza global é tentada.

Em falha: sem novo boot/retry/variante/quarto boot. Encerrar somente próprios vivos
pelo público, guardar indeterminações/reservas/evidências. Timeout de um comando
ou `.close()` não declara cessação nem amplia autoridade de sinal/remoção.
Artefatos, units failed, snapshots e tentativas retidos não são lixo automático.

Ao terminar, reavaliar cada critério03 contra a matriz e declarar lacunas reais.
Nenhuma promessa antecipada de aceite integral. Só integrar após fechar todos
os critérios e conforme autorização de integração já registrada; sem push.
