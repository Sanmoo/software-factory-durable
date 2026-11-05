# Consolidar a spec técnica implementável do MVP

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Claim context: consolidação documental em `wayfinder/software-factory-spec`,
  worktree `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-spec`;
  integração em `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`;
  revisão humana confirmada nesta sessão; reivindicação e validações preservadas nos Comments.
Type: task
Label: wayfinder:task
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 23, 24, 26

## Question

Consolidar as decisões já aprovadas em ../spec.md, conforme a exceção documental explícita do mapa, sem tomar decisões novas.

Pré-condições: revisão cruzada concluída, matriz de aceite aprovada, nenhuma decisão de desenho pendente ou névoa em escopo.
Compor componentes, interfaces/contratos, configuração/comandos, estados/invariantes, roteiro operacional e critérios de validação
com rastreabilidade aos Answers canônicos e ao PRD. A spec é a composição implementável, não uma nova autoridade que altera decisões silenciosamente.
Números de versão/hashes reservados à construção de releases devem permanecer obrigações de release, nunca valores inventados.

Conferir cobertura RF-01–14/RNF-01–05/CA-01–12 e limites de escopo. Se a redação expuser pergunta ainda não decidida,
criar ticket, bloquear esta consolidação e voltar ao operador; não completar por suposição.
Não implementar fábrica, executar provas, decompor tickets de implementação ou alterar mapas/specs antigos.
Concluir com revisão humana do documento, registrando resultado e link como asset desta tarefa, antes de encerrar o mapa.

## Comments

- Retomada da consolidação na sessão Pi `01a1a96f-e4fe-75a8-bc33-e06bd583a21d`, com a reivindicação mantida
  pelo mesmo operador/responsável e na branch/worktree do Claim context. Destino de integração preservado:
  `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`, sem autorização de publicação.
  Incorporar o desenho de stack/interfaces/composição já aprovado, rever a cobertura e submeter o documento completo ao operador;
  esta retomada não aprova a spec nem autoriza implementação, provas ou fechamento do mapa.
- Graduado após o fechamento do contrato operacional; planejamento/documentação somente, sem autorização de implementação ou provas.
- 2026-11-04 — Produzido o asset [Spec técnica — Software Factory MVP](../spec.md), em rascunho para revisão humana.
  Composição do PRD, dos Answers aprovados, da revisão cruzada e do plano de aceite; sem nova decisão de desenho identificada nesta redação.
  Inclui componentes/fronteiras, registros/transações/invariantes, filas/limites, protocolo/recovery, runtime/skills/fontes/revisão,
  sandbox/App, publicação/manutenção/prontidão, instalação/CLI e observabilidade/retenção, com matrizes RF/RNF/CA.
  As versões/hashes finais permanecem obrigações de release; nenhuma implementação, prova de funcionamento ou decomposição foi executada.
- Validação documental: leitura comparada dos contratos, cobertura de 14 RF, 5 RNF e 12 CA sem linhas ausentes/duplicadas;
  referências aos 17 cenários do plano verificadas; 517 links locais/âncoras em 29 arquivos conferidos;
  estrutura Markdown, largura de prosa conforme configuração local, whitespace e pré-requisitos/labels/status do tracker verificados.
  Probe LSP sem erros/warnings; sugestões informativas do corretor inglês sobre português não foram aplicadas.
  Linter Markdown dedicado não disponível; usado checker estrutural local, sem instalação de pacotes.
  Revisão humana permanece pendente: manter `Status: claimed`, sem Answer ou fechamento do mapa até confirmação do operador.
  O rascunho fica na branch/worktree da reivindicação; não publicar `main` nem integrar a consolidação ainda incompleta.
- 2026-11-04 — A revisão humana considerou o conteúdo positivo, mas identificou falta de explicitação da stack de implementação
  e da arquitetura interna do código. Isso revela uma decisão pendente e substitui a avaliação anterior de ausência de lacunas;
  não constitui aprovação final da consolidação. Aberto o pré-requisito
  [Definir a stack de implementação e a arquitetura interna da aplicação](26-implementation-stack-and-application-architecture.md).
  Manter esta tarefa reivindicada e bloqueada, sem preencher os detalhes por inferência. Após a decisão HITL, incorporar o Answer
  na spec, conferir compatibilidade/rastreabilidade e submeter novamente o documento completo à revisão humana antes do fechamento.
- Resolvido o pré-requisito
  [Definir a stack de implementação e a arquitetura interna da aplicação](26-implementation-stack-and-application-architecture.md#answer),
  com o asset [Interfaces públicas e composição — Software Factory MVP](../module-public-interfaces.md). Todos os bloqueadores desta tarefa estão resolvidos.
  Retomar em sessão própria: incorporar o desenho aprovado e revisar a spec completa; esta tarefa continua `claimed`, sem Answer.
  O rascunho foi apenas identificado como desatualizado, não consolidado/aprovado. Preservar sua branch/worktree;
  não integrar esse rascunho junto dos registros da decisão.
- A revisão humana do rascunho revelou a lacuna agora resolvida em
  [Definir a stack de implementação e a arquitetura interna da aplicação](26-implementation-stack-and-application-architecture.md#answer).
  Incorporar o asset [Interfaces públicas e composição — Software Factory MVP](../module-public-interfaces.md),
  conferir compatibilidade/rastreabilidade RF/RNF/CA e submeter novamente a spec completa ao operador em sessão própria.
- Todos os bloqueadores estão resolvidos; esta tarefa permanece `claimed`, sem Answer, e o mapa continua aberto.
  O rascunho não foi aprovado/consolidado ou integrado junto dos registros da decisão. Preservar a branch/worktree do Claim context.
- Contexto preservado no commit `eadd53c2ac5d7d707c66a3d3825e2c29368b40f8` de `wayfinder/software-factory-spec`:
  rascunho em `.scratch/software-factory/spec.md` e histórico da revisão nos Comments deste ticket naquela branch.
  Esse material permanece fora de `main` enquanto incompleto; o cabeçalho só foi atualizado para indicar incorporação arquitetural pendente.
  Não relançar pesquisas ou reconstruir a consolidação do zero sem consultar esse contexto.
- Na retomada indicada no início dos Comments, atualizado o asset [Spec técnica — Software Factory MVP](../spec.md):
  stack/organização, interfaces dos sete módulos, composição dos quatro entrypoints e matriz positiva de dependências na seção 2;
  projeção transitória `BuilderCredentials` na 8.1; testes, cadências e enforcement somente estático na 13.4;
  obrigações de release e condição de fechamento alinhadas. O asset de interfaces e as notas do mapa agora apontam à revisão humana pendente,
  sem modificar os Answers aprovados ou inferir nova decisão de desenho.
- Validação documental da retomada: cobertura de 14 RF, 5 RNF e 12 CA sem linhas ausentes/duplicadas, com correspondência das referências
  V-01–V-17 ao plano aprovado; 40 assinaturas de operações públicas e as dez zonas da matriz comparadas ao asset aprovado.
  Links/âncoras locais, estrutura Markdown, largura de prosa, whitespace e consistência de status/labels/dependências/índice do tracker verificados.
  Probe LSP ativo nos quatro arquivos alterados sem erros/warnings. Não há linter Markdown dedicado disponível;
  usado checker estrutural local, sem instalar pacotes. A primeira execução do checker precisou normalizar as âncoras minúsculas do plano;
  a tabela do Controle também foi alinhada aos identificadores explícitos do asset. A execução final passou.
- Pendente: revisão humana da composição completa pelo operador, não apenas das seções acrescentadas.
  Manter `Status: claimed`, sem Answer, fechamento ou integração/publicação da consolidação enquanto não houver confirmação.
  Nenhuma implementação, prova de funcionamento, benchmark, acesso externo ou decomposição foi executada; não há nova lacuna de desenho identificada.
  Branch/worktree e destino originais permanecem os do Claim context. Os registros da arquitetura já estão em `main` por commit distinto;
  conferir divergência e autorização de rebase da branch de tarefa antes da integração futura, sem reescrever `main` ou criar merge commit.
- O operador confirmou com “aprovo” a revisão integral da versão atualizada, após a pergunta explícita sobre a composição completa
  e o encerramento da consolidação documental. A pendência de revisão está satisfeita; esta confirmação não autoriza implementação,
  provas, piloto, decomposição, rebase ou publicação. A resolução documental abaixo encerra este único ticket não-research nesta sessão.

- Validação após o encerramento documental: 561 links/âncoras locais em 33 arquivos, matrizes RF/RNF/CA e seus cenários,
  40 assinaturas públicas e dez zonas comparadas; todos os 26 filhos resolvidos com Answer, índice completo e dependências sem ciclos.
  Checker estrutural/whitespace passaram; novo probe LSP ativo nos quatro arquivos alterados sem erros/warnings.
  Map/spec/asset de interfaces refletem aprovação final e fechamento, não revisão pendente; nenhuma prova de runtime foi executada.

- O operador autorizou explicitamente a integração/rebase local e o push com “autorizo, inclusive com push”.
  OID da branch antes de qualquer rebase: `842df2beb6b6052d36a7f2e585cd2cd1b6ce9c19`.
  A autorização cobre o fluxo seguro proposto, não force-push, reescrita de `main` ou merge commit.
- Bloqueio operacional descoberto no pré-voo por SSH BatchMode: após fetch, `main` local em
  `3c953777b0bd3c918b9460c829ef47425c70cb8f` e `origin/main` em `cc81bbdc7a6265d29ecf08f9006d67ef42d51074`
  divergem, com 14 commits exclusivos locais e um remoto. O commit remoto “wippY” altera `.vault/bjd/issues/` e worklogs,
  fora deste esforço. A branch remota de tarefa ainda não existe. Não houve rebase, merge, push ou cleanup;
  preservar branch/worktree e alterações alheias até decisão sobre a conciliação das duas histórias de `main`.
  O bloqueio é de integração/publicação, não reabre o destino documental aprovado nem os tickets de desenho.

- O operador informou ter sincronizado `main` e solicitou repetir a operação. Fetch SSH BatchMode confirmou `main`/`origin/main`
  em `c53ac5a6adca04ffaf554515858a4e0899f12c8c`, divergência 0/0; o bloqueio anterior está resolvido.
  OID efetivo anterior ao rebase: `f1a69157641093060bd1022a194fca296dae6e7a`; branch remota de tarefa ausente.
  Rebase local autorizado concluído sobre essa `main`, reaplicando só os três commits posteriores ao desenho já integrado.
  Spec e asset de interfaces foram comparados por conteúdo ao estado pré-rebase: idênticos, antes do ajuste editorial da referência de base documental.
  Histórico de comentários do rascunho e registros já presentes em `main` preservados conjuntamente; nenhuma alteração em decisões de desenho.
  A integração continua pelo fluxo autorizado de fast-forward, push normal de `main` e limpeza apenas dos recursos desta tarefa,
  depois das validações; sem force-push, merge commit ou reescrita de `main`.

- Validação pós-rebase: 563 links/âncoras em 33 arquivos; cobertura RF/RNF/CA e os 17 cenários conferidos;
  40 assinaturas públicas, dez zonas e todos os 26 filhos resolvidos verificados. Spec equivalente à versão aprovada,
  exceto atualização editorial da base documental para o commit correspondente na `main` sincronizada; asset de interfaces idêntico.
  Comentários históricos das duas origens preservados; delta restrito aos quatro arquivos desta tarefa.
  Checker estrutural/whitespace e probe LSP ativo passaram, sem erros/warnings. Sem testes de funcionamento da Factory.

## Answer

### Spec consolidada e aprovação humana

Consolidada a [Spec técnica — Software Factory MVP](../spec.md), incorporando as decisões aprovadas do mapa,
o desenho de [Interfaces públicas e composição — Software Factory MVP](../module-public-interfaces.md)
e a [Matriz de aceite e sequência de validação incremental](../acceptance-and-incremental-plan.md).
O operador aprovou explicitamente a composição completa com “aprovo” nesta sessão, após a revisão que incorporou a arquitetura interna;
a aprovação não foi inferida das confirmações parciais anteriores.

O documento organiza componentes/fronteiras, stack/interfaces/composição, persistência/estados/invariantes,
admissão/filas/limites, protocolo/recovery, runtime/skills/fontes/revisão, sandbox/App/credenciais,
publicação/prontidão/manutenção, instalação/CLI, observabilidade/retenção e critérios de validação.
O PRD permanece autoridade de produto; Answers preservam decisões/justificativas, e os assets vinculados guardam o detalhamento.
A spec não altera decisões silenciosamente nem inventa versões, hashes ou capacidade ainda reservados à construção/validação.

### Verificações e conclusão do mapa

Cobertura de RF-01–14, RNF-01–05 e CA-01–12 conferida com as referências aos 17 cenários do plano aprovado;
40 assinaturas de operações públicas e dez zonas da matriz de dependências comparadas ao desenho aprovado.
Validações documentais, links/âncoras, whitespace, probe LSP e consistência do tracker registrados nos Comments;
sem prova de funcionamento ou homologação da composição real.

Todos os pré-requisitos estão resolvidos. Não resta ticket aberto nem névoa/decisão de desenho em escopo identificada;
o destino documental foi alcançado e o mapa é encerrado com ponteiro para esta resolução.
Implementação, decomposição em tickets, construção/validação de release e piloto pertencem a esforços posteriores,
com autorizações próprias. Aprovar a spec não aceita o MVP nem autoriza execução desses trabalhos.

### Integração dos registros

Destino preservado: `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`.
A branch/worktree de consolidação é a do Claim context. Rebase local, integração fast-forward, limpeza e push foram autorizados explicitamente.
O operador sincronizou `main`/`origin/main`; a sincronização foi verificada e o rebase da tarefa concluído, conforme os Comments.
Registros preparados para integração em `main` por fast-forward e publicação normal, preservando trabalho alheio e as decisões aprovadas;
limpeza somente após validação e confirmação da integração. Não há autorização de implementação, force-push, merge commit ou reescrita de `main`.
