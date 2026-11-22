# 25: Início de boot não confirmado e MicroVM sem tag: recuperação e inventário (A2)

**What to build:** Dois restos do achado A2. (1) Um `RunMicrovm` recusado por erro de uso deixou a Execução retida (`START_MICROVM_START_UNCONFIRMED`) e a saída exigiu `factory resume --retry-blocked-start` do Operador; decidir se recusas determinísticas do início merecem recuperação limitada automática ou Bloqueio com a causa na primeira linha. (2) O serviço não aceita tag na MicroVM: o inventário usa a tag da imagem e os registros de boot. Registrar na spec que V2-34 ("por tag") vale pela tag da imagem, cobrir com teste a órfã sem registro de boot, e documentar que o uso de MicroVM não aparece no filtro por tag da cobrança.

Origem: [Aceite da v2 no perfil Lambda](16-v2-acceptance-on-lambda-profile.md), campanha de 2026-11-21 e 22. Os caminhos de evidência são relativos ao diretório local da campanha.

**Blocked by:** nenhum

**Type:** task

**Status:** needs-triage

## Observed

- Janela 1: `execution-held START_MICROVM_START_UNCONFIRMED` às 23:12:34 UTC; `blocked-start-retried` e `recovery-requested operator-retry` às 23:36:21, depois da release v2-acc-2.
- Reconciliação do C06: a órfã foi encerrada a partir do registro de boot; o caso sem registro de boot não foi exercitado na conta (critério G32 ficou parcial).
- Evidência: `final-works/a23f433b-2e61-4e36-a1cc-770757201a19.history.json`, `final-works/6acadbcb-ebb0-4653-bfd6-885d0affbbfa.history.json`; registro corrido, achado A2.

## Why it matters

Autonomia (o Operador precisou intervir por um defeito do produto) e fidelidade da spec ao serviço real (V2-34 e custo por tag).

## Acceptance criteria

- [ ] Decisão registrada sobre recusa determinística no início do boot: recuperação limitada ou Bloqueio; em qualquer caso a linha útil do erro aparece no `show`.
- [ ] A spec da v2 descreve o inventário pela tag da imagem e pelos registros de boot.
- [ ] Teste (fake da conta) da MicroVM órfã sem registro de boot encerrada pela reconciliação.
- [ ] `docs/lambda-installation.md` diz que o uso de MicroVM não aparece no filtro por tag da cobrança.
