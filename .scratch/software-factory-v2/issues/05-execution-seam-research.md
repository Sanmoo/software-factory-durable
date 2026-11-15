# Localizar a interface de execução e as dependências entre harness e sandbox

Status: open
Type: research
Label: wayfinder:research
Map: [Software Factory v2 — ambientes reconstruíveis e harnesses substituíveis](../map.md)
Blocked by: 04

## Question

Quais contratos existentes podem atender Pi e Claude Code, e quais diferenças precisam ser provadas
antes de desenhar uma interface implementável, considerando a direção de sandbox reconstruível?

## References

- [Direção de harnesses](04-substitutable-harnesses-direction.md#answer).
- [Direção de sandbox](01-lambda-microvms-direction.md#answer).
- [Interfaces públicas do MVP](../../software-factory/module-public-interfaces.md).
- [Spec do MVP](../../software-factory/spec.md).
- [Pesquisa de assinatura Claude Code](../../software-factory/research/claude-code-subscription.md).

## Scope

- Inventariar Workers, protocolo, controle de sessão, ferramentas e Sandbox nos documentos e na
  implementação disponível; registrar refs/versões e distinguir aprovado, implementado e demonstrado.
  Worktrees/branches de implementação em andamento são evidência de estado, não autoridade aprovada.
- Localizar o seam adequado: preferir reutilizar/refinar Workers se suficiente, sem camada pass-through,
  framework de plugins ou abstração de todos os harnesses imagináveis.
- Confrontar CLI e Agent SDK oficiais com Pi: ativação, eventos, pergunta/revisão, sessão substituta,
  cancelamento/cessação, modelos por papel, uso indisponível versus zero e erros/quotas.
- Avaliar localização do loop e das ferramentas, confinamento, descobertas de configuração e gestão
  nativa de credenciais. Não presumir shell Claude seguro no host nem equivalência de allowedTools
  com proibição técnica de escrita. Não copiar tokens do Operador para outro harness.
- Distinguir interface de harness e sandbox, requisitos mínimos e capacidades da combinação.
  Identificar pressupostos host/guest da direção v2 que precisariam voltar à decisão; não alterá-los.
- Definir hipóteses e cenários que desbloqueiem a spec da prova, incluindo fonte mínima de contexto
  independente de transcript e reconfiguração entre inicializações. Não desenhar a interface final.
- Reutilizar pesquisa existente, revalidando somente fatos mutáveis/decisivos nas fontes primárias.
  Não exigir conclusão da prova Lambda para investigar a trilha de harness.

## Exit criteria

Relatório com rastreabilidade para contratos/código/fontes, lacunas e hipóteses testáveis, sem decisão
de adoção ou compatibilidade alegada sem prova. Propor ao operador alternativas decisivas se houver
conflito de autoridade/permissão. Sem instalar, executar inferência, login, provisionar ou implementar.
