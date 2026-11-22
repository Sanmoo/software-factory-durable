# 26: Trabalho cancelado com Pergunta aberta: saída para limpeza e esquecimento (A19)

**What to build:** Um Trabalho cancelado que ainda tem uma Pergunta aberta fica sem saída: a Pergunta não pode mais ser respondida e, por estar aberta, protege o Trabalho contra a limpeza do ambiente e contra o `forget`. O ambiente dele e a imagem de MicroVM que ele usa nunca saem pelo produto. O cancelamento passa a encerrar as Perguntas abertas do Trabalho (ou a proteção deixa de valer para Trabalho cancelado), de modo que limpeza e esquecimento funcionem.

Origem: [Aceite da v2 no perfil Lambda](16-v2-acceptance-on-lambda-profile.md), campanha de 2026-11-21 e 22. Os caminhos de evidência são relativos ao diretório local da campanha.

**Blocked by:** nenhum

**Type:** task

**Status:** needs-triage

## Observed

- Trabalhos `67f6c34e` e `8019ed17` do repositório de apoio, cancelados com Pergunta pendente: `factory answer` → `not-applied WORK_NOT_OPEN`; `factory cleanup <trabalho> --select environment` → `PROTECTED QUESTION_OPEN`; `forget` → `PROTECTED` e `RESOURCES_PENDING`.
- `factory cleanup-images` manteve a última imagem como `in-use … kept` por causa desses dois Trabalhos; ela só saiu pela CLI da AWS.
- A retenção já mostrava a proteção: `retained:undelivered:0 eligible:protected:QUESTION_OPEN`.
- Evidência: `cleanup-images-final.json`, `cleanup-environments.jsonl`, `final-works/8019ed17-3e55-45d0-b77f-552b0d9f5b07.history.json`, `final-works/67f6c34e-f14e-4c99-a5b3-66e700aade5e.show.json`; registro corrido, seção "Fechamento".

## Why it matters

Recursos pagos (imagem de MicroVM) e dados locais ficam presos sem comando que os libere; o Operador precisa ir à conta AWS à mão. Contraria a limpeza explícita de imagens (V2-33, V2-34) e a regra de que todo Bloqueio tem próximo passo (CA-12).

## Acceptance criteria

- [ ] Depois de `factory cancel`, nenhuma Pergunta do Trabalho continua aberta para fins de proteção; o histórico registra o encerramento da Pergunta pelo cancelamento.
- [ ] `factory cleanup <trabalho> --select environment` e `forget` funcionam num Trabalho cancelado que tinha Pergunta pendente.
- [ ] `factory cleanup-images` remove a imagem quando só Trabalhos cancelados e já limpos a referenciam.
- [ ] Teste automatizado do cenário: Pergunta publicada, cancelamento, limpeza do ambiente, limpeza da imagem.
