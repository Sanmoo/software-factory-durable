# 02: Operar um controlador exclusivo com pausa durável

**What to build:** O operador inicia um único controlador e consulta ou altera a pausa pela CLI, com resultado durável e consultável mesmo quando a conexão cai. Reinício preserva a pausa, e nenhuma atuação é liberada antes da reconciliação.

**Blocked by:** [01: Preparar a instalação local e o gate de desenvolvimento](01-local-setup-and-development-gate.md)

**Status:** resolved

**Claim context:** local task branch `implement/software-factory-mvp-02`, based on integration `84647f1`; real temporary storage/socket/process tests only.

## Acceptance criteria

- [x] Lock estável do storage canônico é adquirido antes de abrir Pi Durable/SQLite ou aceitar mutações; segunda abertura e aliases não criam outro proprietário, e subprocessos não herdam o descritor.
- [x] SQLite efetivamente embarcado tem correção WAL-reset verificada e opera WAL/synchronous=FULL nos commits de controle pela fronteira pública suportada; falha de persistência não produz ACK durável.
- [x] Status, pause, unpause e request passam por socket privado, sem leitor operacional paralelo; controlador indisponível é erro explícito, não lista vazia.
- [x] Identidade do pedido e transição/histórico são confirmados no mesmo commit; mesmo ID/conteúdo retorna resultado conhecido, conteúdo diferente falha e perda de ACK permite consultar ou repetir a mesma identidade.
- [x] Framing JSON por linha valida versão/limites, fragmentação e campos; transporte não confunde recibo de bytes com confirmação durável.
- [x] Barreira começa fechada inclusive em resume/submit/waits e caminhos fora do loop principal; pausa persiste sem cancelar Trabalhos ou autorizar despacho implicitamente.
- [x] Testes com storage e sockets temporários reais cobrem reinício, falhas de commit, exclusividade e ingresso duplicado; regras usam dados/tempo controlados, sem domínio ou scheduler paralelo.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 3.1, 3.4, 5.1, 5.2, 11.3, 13.4; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-01, V-11 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Implementado no escopo **sem Execuções** deste ticket, com evidências e limites
em [docs/controller-evidence.md](../../../docs/controller-evidence.md).
Nenhum scheduler/domínio paralelo, SQLite CRUD substituto, modelo ou storage de produção.

- Pi Durable/Chord públicos **1.5.0**, `Session` + `SqliteStorage` reais;
  SQLite embarcado **3.53.4**, source id e WAL/FULL lidos/verificados pelo owner.
  Falha de escrita real por limite de arquivo no processo isolado não produz ACK,
  nem pausa/histórico/pedido parcialmente aplicados após reabertura.
- Launcher flock exclusivo/não bloqueante/no-fork, lock estável por raiz canônica,
  aliases de raiz recusando segundo proprietário e aliases symlink/hardlink de DB
  recusados. Owner interno exige posse verificada; subprocesso real sobrevivente
  não conserva o lock após SIGKILL do dono.
- Status/pause/unpause/request por socket privado, versão/campos/frames limitados,
  fragmentação UTF-8 e fechamento/erros. CLI offline não lê SQLite.
- Commit Session único para pausa/histórico/ingresso/recibo; ACK perdido permanece
  consultável, oito duplicatas concorrentes retornam conhecido, conflito recusa.
- Barreira fechada antes da Session e **mantida fechada neste incremento**.
  Inventário persistido real de tarefas e filesystem próprio delimitam instalação
  vazia; recursos desconhecidos mantêm reconciliação pendente. `unpause` não libera
  efeitos. Não existem resume/submit/waits de Harness ou fases de Builder acessíveis
  aqui; `Control` só expõe accept/inspect/run, sem Session/SQL bruto.
  Futuros tickets de ativação devem instalar/provar guardas em todos os seus caminhos
  de efeito; este aceite não declara essas provas futuras como executadas.

Decisões de composição confirmadas pelo supervisor durante a implementação:
validar configuração completa antes de abrir SQLite; usar reconciliação sem tarefas
sem inventar fases futuras; corrigir somente a aresta de bootstrap configuration do
controller já aprovada em Q13, com fixtures positivas/negativas; permitir
`skipLibCheck: true` explicitamente por defeitos de declarações upstream, mantendo
strict/exactOptionalPropertyTypes e prova negativa de fontes autorais. Os 12 TS2344
Chord e TS2307 do peer opcional genai estão registrados na evidência; nenhuma
alegação de declarações de dependências limpas, patch vendor ou runtime MCP.

Validação local: `npm ci`; `npm test` (45/45, nenhum skipped, gate arquitetural +
build estrito); `npm run typecheck`; `git diff --check`. RED/GREEN e quais testes
foram provas de regressão já verdes estão discriminados no documento de evidências.
Os testes usam processos, locks, sockets, filesystem e SQLite temporários reais;
configuração/provider/chave sintéticos **não** comprovam suas integrações.

Sem instalação systemd/pacotes do sistema, credenciais/modelos reais, GitHub mutável,
injeção em sistemas existentes ou piloto. A revisão independente e a integração
continuam sob o supervisor; resolução local deste incremento não aprova o MVP.
