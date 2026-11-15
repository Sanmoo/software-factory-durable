# Validar Pi e Claude Code nos contratos de execução e continuidade

Status: open
Type: prototype
Label: wayfinder:prototype
Map: [Software Factory v2 — ambientes reconstruíveis e harnesses substituíveis](../map.md)
Blocked by: 06

## Question

Pi e Claude Code cumprem os contratos exigidos e permitem continuar o mesmo Trabalho após parada,
reconfiguração e reinício, sem migrar transcripts nem enfraquecer isolamento e recuperação?

## Authorization gate

Marcar claimed antes de trabalhar. Antes de executar, obter autorização específica conforme a
[spec da prova](06-harness-proof-spec.md): ambiente, conta/assinatura, permissões, limites de consumo,
prazo/custo e cleanup. Não inferir essa autorização da direção aprovada ou do fechamento da spec.
Não usar credenciais de terceiros, código privado ou serviços reais fora do escopo autorizado.

## Scope and evidence

- Executar a spec aprovada, com repositório descartável e versões/perfis registrados. Código de
  experimento é descartável, não implementação de produção nem aprovação da interface definitiva.
- Preservar evidências por cenário, falhas e limitações; sanitizar logs e separar consumo conhecido,
  estimado e indisponível. Não contornar quota nem trocar de cobrança/harness silenciosamente.
- Demonstrar o que depende de Claude real, inclusive os três papéis, restrições e ciclo de vida.
  Evidência apenas de chamada -p, prompt de read-only ou retorno exit 0 é insuficiente.
- Demonstrar ambos os sentidos de reconfiguração no mesmo Trabalho, cessação e recuperação de
  contexto independente de sessão, sem reset de histórico/controles ou repetição cega de efeitos.
- Classificar cada critério obrigatório como aprovado, reprovado ou inconclusivo. Em desvio que
  altere desenho/permissões/custo autorizado, parar e retornar ao operador; não trocar a hipótese.
- Inventariar/remover recursos próprios e reportar resíduos. Não tocar ambientes ou processos de
  outros Trabalhos. Esta prova não homologa Lambda nem todas as combinações harness/sandbox.

## Exit criteria

Relatório reproduzível, resultados por critério e cleanup verificado. Resultado negativo/inconclusivo
é válido e deve alimentar a decisão seguinte, sem fingir compatibilidade nem implementar alternativa.
Não alterar PRD/spec do MVP ou aprovar produção a partir deste relatório.
