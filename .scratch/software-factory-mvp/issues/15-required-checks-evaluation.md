# 15: Explicar os checks obrigatórios do PR atual

**What to build:** O operador vê quais checks realmente são obrigatórios para o PR e por que cada requisito está satisfeito, pendente, falho ou indeterminado. Resultados antigos, de outra origem ou incompletos não tornam o PR verde.

**Blocked by:** [14: Publicar e reconhecer o PR draft próprio](14-direct-draft-publication-and-discovery.md)

**Status:** resolved

## Acceptance criteria

- [x] Leituras completas por gh api cobrem identidade/head/base/merge de teste, conflito triestado, proteção tradicional, rulesets ativos aplicáveis/herdados, check-runs e statuses com paginação/tentativa/origem/SHA.
- [x] Requisitos tradicionais e rulesets são acumulados com contexto/integração e strict/loose; 404/acesso negado ou rollup não enumerado não provam ausência de regra/contexto obrigatório.
- [x] Cada requisito usa SHA pertinente e origem/tentativa atuais; check-run/status homônimos exigidos precisam de ambos, e rerun pendente/falho não é encoberto por verde anterior.
- [x] Check-run success/skipped/neutral e status success seguem semânticas distintas; obrigatório ausente/pending é espera sem Slot, não sucesso nem defeito genérico.
- [x] Failure pertinente, causa operacional e causa incerta são classificados com motivos próprios; opcionais/antigos ficam visíveis sem reparo automático por si.
- [x] Modalidade relevante não interpretável, como workflow obrigatório/merge queue não suportados, é incompatibilidade/indeterminação; conjunto obrigatório vazio requer leitura completa autorizada.
- [x] Regras são testadas com dados controlados e integração GitHub real cobre requisitos/resultados declarados suportados; avaliação explica instante, completude e limitações sem assumir snapshot atômico.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 9.2, 9.3; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-09, V-15 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-15: o Controle explica, por PR próprio vinculado pelo ticket 14, quais checks o GitHub realmente exige para o head
atual e por quê. O CodeRepository ganha a operação aprovada Q4B `readPullRequest` (grant reduzido `checks-read`, só GET): PR
(identidade, head/base, draft, merge de teste, `mergeable` triestado), resumo da proteção clássica e seu detalhe quando aplicado,
regras ativas da base (inclusive herdadas), check-runs (todas as tentativas, `total_count` conferido, teto de 1000 = incompleto) e
statuses do head, comparação com a ponta da base e releitura final do PR e dos requisitos; item malformado fica desconhecido sozinho.
Regras puras acumulam requisitos clássicos + rulesets por contexto+integração com strict/loose; escolhem a tentativa atual (suíte mais
recente por instante; suítes não ordenáveis que divergem = indeterminado); check-run e status homônimos exigidos precisam de ambos;
status conta para requisito de qualquer origem e, ligado a integração, só quando o criador é o bot dessa App (senão outra origem ou
`STATUS_ORIGIN_UNVERIFIABLE`); ausente/pendente = espera sem Slot; falha pertinente, causa operacional, incerta e indeterminação têm
motivos independentes; opcionais/outro SHA só visíveis; modalidade não interpretável e leitura incompleta nunca viram conjunto vazio;
mudança durante a coleta invalida. O rastreamento roda no laço do dono após o tick (intervalo por Trabalho, backoff com `waitSeconds`,
leitura leve de head inalterado, janela de leituras, commit só em mudança) e nunca cria Slot, fila, impedimento, reparo ou prontidão
(decisão do operador: 15 explica, 16/22 decidem). Gate `test:ci` verde. Ensaio real `q15-checks-v2` (somente leitura, 32 GET, 0
recusados; cópias do armazenamento q14-v8 migradas explicitamente com digest preservado) explicou o PR draft #5 @ `bfdd439` como
`satisfied` com conjunto obrigatório `empty-complete` a partir de leituras completas e regras do ruleset interpretadas. Lacuna
registrada: o repositório de teste não tem check obrigatório, então pendente/falha/rerun/homônimos reais são só de fixture; proposta de
ensaio real complementar com workflow + ruleset configurados pelo operador. Evidência: `docs/evidence/15-required-checks-evaluation.md`.
