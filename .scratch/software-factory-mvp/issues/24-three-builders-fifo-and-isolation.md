# 24: Executar três Builders com FIFO e isolamento comprovados

**What to build:** A instalação executa três Builders reais simultaneamente, incluindo dois no mesmo repo, e mantém ordem, prioridade e isolamento verificáveis mesmo com Docker e revisores. O operador vê capacidade real em vez de inferi-la da configuração virtual.

**Blocked by:** [22: Executar reparos automáticos por impedimentos efetivos](22-effective-impediments-and-automatic-repairs.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Três Builders reais usam branch/checkout/workspace/disco/VM próprios; dois no mesmo repo não compartilham metadados graváveis nem sofrem mutex global de execução.
- [ ] FIFO normal preserva admissão, reparos têm prioridade/FIFO próprios sem preempção; impedidos são ignorados temporariamente sem perder posição, e nova correção posterior recebe nova sequência.
- [ ] Pergunta e espera por CI/merge não ocupam Slot após cessação; reviews internos compartilham Slot/relógio, e reservas incertas continuam ocupando capacidade.
- [ ] Cache sequencia apenas fetch e cópia concluída do mesmo repo, enquanto Builders já preparados e repos diferentes seguem paralelos; crash no preparo não permite mutar cache com processo antigo atuando.
- [ ] Containers de suites reais de integração rodam simultaneamente sem colisão de portas/volumes/nomes ou cleanup alheio; adequação necessária é explícita, não reescrita/bypass silencioso.
- [ ] Falha de worker/adapter/VMM de um Trabalho não encerra os outros nem libera capacidade incerta; nenhum substituto cria segundo escritor.
- [ ] Registro mede RAM/CPU/I/O/disco com overhead e vfs, workers/revisores, Slots/filas e configuração/host; limites virtuais não são reserva física ou capacidade total comprovada, sem SLA/teto inventado.
- [ ] Regras automatizadas e composição real com agentes demonstram prioridade, retomada com posição correta e independência; suites específicas dos pilotos permanecem obrigação adicional do piloto.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 3.3, 4.3, 7.3, 7.4, 12.1, 13.2; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-02, V-06, V-12 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
