# Especificar a prova de harnesses substituíveis com Pi e Claude Code

Status: open
Type: grilling
Label: wayfinder:grilling
Map: [Software Factory v2 — ambientes reconstruíveis e harnesses substituíveis](../map.md)
Blocked by: 05

## Question

Qual experimento limitado demonstra os requisitos aprovados de execução e continuidade com Pi e
Claude Code sem antecipar a interface de produção nem depender da homologação de Lambda?

## References

- [Direção aprovada](04-substitutable-harnesses-direction.md#answer).
- [Investigação da interface de execução](05-execution-seam-research.md).
- [Prova Lambda independente](02-lambda-microvms-prototype.md).

## Scope

- Produzir spec da prova em documento auxiliar desta feature, com requisitos, hipótese, fixtures,
  versões/perfis, comandos previstos, evidência esperada e critério de aprovação por cenário.
- Cobrir Claude nos três papéis e fluxo combinado; perguntas/ACK/suspensão/retomada; read-only real;
  confinamento; cessação/cancelamento/crash; efeitos incertos; Pi → Claude e Claude → Pi por parada,
  alteração de configuração e reinício. Incluir preservação e perda sem presumir sessões convertíveis.
- Separar cenários determinísticos com mocks dos que exigem execução real; fixar qual composição
  local é avaliada e o que permanece sem evidência para Lambda e a composição final da v2.
- Definir como coletar resultados reproduzíveis sem segredos/código privado, consumo com lacunas
  explícitas, falhas induzidas e condições de parada. Aprovado/reprovado/inconclusivo por critério;
  critério obrigatório inconclusivo não permite aprovar a integração.
- Definir autenticação nativa dedicada do Operador e verificar termos atuais. Evitar herança do
  perfil pessoal e API key inadvertida; sem --bare como suposta solução OAuth, extração de tokens,
  compartilhamento de conta, contorno de quota ou fallback pago silencioso.
- Submeter ambiente, assinatura/conta, permissões, limites de consumo/prazo, eventual custo e cleanup
  à autorização específica. Limites não mensuráveis precisam de diagnóstico/condição de parada,
  não ser apresentados como orçamento garantido.
- Decidir somente o necessário ao experimento. Interface implementável e alterações de autoridade
  pertencem à decisão de composição posterior; não congelar abstração com base em um só adapter.

## Exit criteria

Spec da prova aprovada pelo operador, rastreável à direção e à investigação, sem lacunas críticas
preenchidas por suposição. Registrar separadamente aprovação do desenho e autorização de execução;
resolver este ticket não autoriza automaticamente iniciar o experimento ou inferência.
