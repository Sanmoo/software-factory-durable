# 15: Explicar os checks obrigatórios do PR atual

**What to build:** O operador vê quais checks realmente são obrigatórios para o PR e por que cada requisito está satisfeito, pendente, falho ou indeterminado. Resultados antigos, de outra origem ou incompletos não tornam o PR verde.

**Blocked by:** [14: Publicar e reconhecer o PR draft próprio](14-direct-draft-publication-and-discovery.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Leituras completas por gh api cobrem identidade/head/base/merge de teste, conflito triestado, proteção tradicional, rulesets ativos aplicáveis/herdados, check-runs e statuses com paginação/tentativa/origem/SHA.
- [ ] Requisitos tradicionais e rulesets são acumulados com contexto/integração e strict/loose; 404/acesso negado ou rollup não enumerado não provam ausência de regra/contexto obrigatório.
- [ ] Cada requisito usa SHA pertinente e origem/tentativa atuais; check-run/status homônimos exigidos precisam de ambos, e rerun pendente/falho não é encoberto por verde anterior.
- [ ] Check-run success/skipped/neutral e status success seguem semânticas distintas; obrigatório ausente/pending é espera sem Slot, não sucesso nem defeito genérico.
- [ ] Failure pertinente, causa operacional e causa incerta são classificados com motivos próprios; opcionais/antigos ficam visíveis sem reparo automático por si.
- [ ] Modalidade relevante não interpretável, como workflow obrigatório/merge queue não suportados, é incompatibilidade/indeterminação; conjunto obrigatório vazio requer leitura completa autorizada.
- [ ] Regras são testadas com dados controlados e integração GitHub real cobre requisitos/resultados declarados suportados; avaliação explica instante, completude e limitações sem assumir snapshot atômico.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 9.2, 9.3; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-09, V-15 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
