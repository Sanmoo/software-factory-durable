# 24: Executar três Builders com FIFO e isolamento comprovados

**What to build:** A instalação executa três Builders reais simultaneamente, incluindo dois no mesmo repo, e mantém ordem, prioridade e isolamento verificáveis mesmo com Docker e revisores. O operador vê capacidade real em vez de inferi-la da configuração virtual.

**Blocked by:** [22: Executar reparos automáticos por impedimentos efetivos](22-effective-impediments-and-automatic-repairs.md)

**Status:** resolved

## Acceptance criteria

- [x] Três Builders reais usam branch/checkout/workspace/disco/VM próprios; dois no mesmo repo não compartilham metadados graváveis nem sofrem mutex global de execução.
- [x] FIFO normal preserva admissão, reparos têm prioridade/FIFO próprios sem preempção; impedidos são ignorados temporariamente sem perder posição, e nova correção posterior recebe nova sequência.
- [x] Pergunta e espera por CI/merge não ocupam Slot após cessação; reviews internos compartilham Slot/relógio, e reservas incertas continuam ocupando capacidade.
- [x] Cache sequencia apenas fetch e cópia concluída do mesmo repo, enquanto Builders já preparados e repos diferentes seguem paralelos; crash no preparo não permite mutar cache com processo antigo atuando.
- [ ] Containers de suites reais de integração rodam simultaneamente sem colisão de portas/volumes/nomes ou cleanup alheio; adequação necessária é explícita, não reescrita/bypass silencioso. — **limite de ambiente/piloto registrado (decisão do operador 2026-11-16; ver Answer)**
- [x] Falha de worker/adapter/VMM de um Trabalho não encerra os outros nem libera capacidade incerta; nenhum substituto cria segundo escritor.
- [x] Registro mede RAM/CPU/I/O/disco com overhead e vfs, workers/revisores, Slots/filas e configuração/host; limites virtuais não são reserva física ou capacidade total comprovada, sem SLA/teto inventado.
- [x] Regras automatizadas e composição real com agentes demonstram prioridade, retomada com posição correta e independência; suites específicas dos pilotos permanecem obrigação adicional do piloto.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 3.3, 4.3, 7.3, 7.4, 12.1, 13.2; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-02, V-06, V-12 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-16 por decisão do operador: não haverá ensaio v4, e o AC5 fica registrado como limite de ambiente/piloto. Uma passada
de despacho preenche todos os Slots livres em ordem de fila: reparos antes, FIFO, sem preempção nem mutex global ou por repo. Um candidato
recusado na própria revalidação é pulado nessa passada sem perder a posição, com no máximo 4 recusas por passada. Pergunta e espera não
ocupam Slot após a cessação; revisores rodam no Slot e boot do próprio Builder; Slots incertos continuam ocupados e nenhum substituto vira
segundo escritor. Cada boot exige memória livre ≥ guest + piso + outros boots próprios ainda lançando (pré-condição, não reserva), e o
`doctor` julga só os Slots livres contra o host observado. A receita one-shot `q24-three` traz o registro por unit (cgroup do systemd), host
e armazenamento do guest.

Ensaios reais (supervisor, issues #21–#23, #39–#41, #44–#46), todos retidos por expectativas da receita ou do ambiente, nunca por falso
verde. Provaram três VMs isoladas reservadas numa única passada (capacidade 3), ambiente, boot e branch próprios, Perguntas independentes,
cessação confirmada antes da liberação dos Slots, unidades medidas, Docker do guest com Testcontainers/Ryuk funcionando e containers
simultâneos sem colisão (v1: três VMs; v3: duas). Gates falhos nunca ficaram verificados.

**AC5, limite:** "três suites reais verdes ao mesmo tempo" não foi alcançado porque `CreditAccountUseCaseConcurrencyIT` (dois testes
diferentes) e `JdbcOutboxEventAdapterIT` falharam no guest. A causa é **hipótese NÃO confirmada**: timing sob 2 vCPU/`vfs`/contenção de 3
VMs, ou bug real do repositório. Esses testes nunca rodaram no host nem numa VM sozinha. Se um diagnóstico posterior mostrar que falham
também no host, isso será registrado como limite do repositório, sem mudança no repo de teste. Fica também como lacuna "repos diferentes
em paralelo", provado só localmente.

Evidência: `docs/evidence/24-three-builders-fifo-and-isolation.md` e `docs/evidence/24-real-q24-three-v{1,2,3}-summary.json`.

