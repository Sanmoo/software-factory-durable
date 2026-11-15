# Decidir a composição de harnesses e sandboxes da v2

Status: open
Type: grilling
Label: wayfinder:grilling
Map: [Software Factory v2 — ambientes reconstruíveis e harnesses substituíveis](../map.md)
Blocked by: 02, 07

## Question

À luz das duas provas, qual composição de harness, ferramentas, transporte e sandbox pode integrar
a v2, com contratos coerentes e garantias demonstráveis, antes de consolidar o PRD/spec?

## References

- [Direção de sandbox](01-lambda-microvms-direction.md#answer).
- [Prova Lambda/Docker/transporte](02-lambda-microvms-prototype.md).
- [Direção de harnesses](04-substitutable-harnesses-direction.md#answer).
- [Prova Pi/Claude](07-harness-compatibility-prototype.md).
- [Consolidação do PRD/spec](03-revised-sandbox-contract.md).

## Scope

- Confrontar resultados e limites das duas trilhas. Provas locais independentes não demonstram
  automaticamente a combinação; identificar evidências cruzadas faltantes e abrir filhos quando
  necessários, sem declarar aprovação por soma de dois smokes.
- Decidir localização dos loops/ferramentas, fronteira confiável host/guest, credenciais/perfis e
  restrições por papel. Compatibilidade deve ser explícita por composição suportada, sem prometer
  produto cartesiano, herança do perfil pessoal ou métodos proprietários no controlador.
- Confirmar interface mínima de execução: reutilização/evolução de Workers versus seam adicional
  somente se justificado pelos dois adapters concretos. Não confundir harness com provider de modelo.
- Resolver continuidade do Trabalho versus sessão nativa e boot: contexto de recuperação,
  preservação Git/gate, parada/reconfiguração/reinício, identidade/geração, cessação e efeitos incertos.
  Sem comando de troca, conversão obrigatória de transcript ou reinício que zere limites.
- Distinguir capacidades opcionais de requisitos obrigatórios da fábrica/repo/papel. Falta de
  capacidade exigida deve bloquear com diagnóstico; relaxamento de propriedade exige decisão humana.
- Avaliar enquadramento da assinatura e carga do Operador, custos/quotas e suporte por versão.
  Não equiparar possibilidade técnica a autorização contratual nem consumir recursos para esclarecer
  lacunas sem autorização específica.
- Obter decisão sobre inviabilidade/inconclusão e alternativas quando necessário. Não abandonar
  silenciosamente Lambda/Claude nem homologar o restante como se a direção integral tivesse passado.
- Definir cenários/gates de validação integrada e distinguir evidência já obtida de prova futura.
  Se for preciso protótipo cruzado antes da decisão, criar filho e aguardar seu resultado.

## Exit criteria

Answer aprovado pelo operador com composição suportada, contratos/limitações, diferenças frente ao
MVP, evidências e pendências explícitas. Divergência da direção exige confirmação. Não fechar com
lacunas obrigatórias ocultas; se necessário criar dependências adicionais antes de resolver. Não
implementar produção nem alterar retroativamente decisões do MVP.
