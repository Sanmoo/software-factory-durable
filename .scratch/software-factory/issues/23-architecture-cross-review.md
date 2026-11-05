# Revisar a composição da arquitetura e suas fronteiras

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Claim context: sessão Pi `01a1a753-8583-75a8-bc33-e0636e722307`; branch `plan/software-factory-cross-review`, worktree `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-cross-review`; integração em `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`, sem publicação de `main`.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 21

## Question

A composição das decisões aprovadas forma uma arquitetura coerente e mínima, sem contratos incompatíveis, lacunas de autoridade ou complexidade acidental?

Revisar interfaces e invariantes entre controlador Pi Durable/SQLite, workers Pi, adapter Gondolin, CLI e GitHub.
Cruzar autorização/escopo, filas/Slots, cessação/recovery, sessões/reviews, publicação/lease, prontidão/manutenção, configuração e retenção.
Verificar expressamente os ajustes operacionais posteriores: conta dedicada recomendada e serviço do controlador opcional
não eliminam supervisão systemd dos ambientes; instalação autocontida não promete relocação; backup integrado está fora do MVP.

Produzir análise de compatibilidade e decisões de correção justificadas quando necessárias, com confirmação humana.
Não reabrir escolhas já aprovadas por preferência, nem confundir documentação com prova. Se houver lacuna que exija pesquisa ou outra decisão,
criar ticket e dependência real; não preencher com hipótese. Não implementar, provisionar, executar provas ou consolidar a spec nesta decisão.
A resolução precisa deixar explícito quais contratos permanecem válidos e quaisquer ajustes aprovados em seus registros canônicos.

## Comments

- Graduado após o fechamento do contrato operacional; planejamento/documentação somente, sem autorização de implementação ou provas.
- Claim integrado localmente em `main` no commit `4fb26da`; branch/worktree no Claim context identificam os recursos históricos desta sessão, removíveis após integração limpa, sem publicação de `main`.
- Rodada Q1–Q4 aprovada pelo operador com “de acordo com as recomendações”: exclusão/dependências, parada administrativa limpa,
  acesso a saídas longas e fontes privadas. Não houve aprovação inferida nem nova escolha de tecnologia.
- [Análise de compatibilidade](../architecture-cross-review.md): cruzamento e achados documentais. Regras finais ajustadas nos contratos canônicos abaixo.
- Uma única decisão não-research resolvida nesta sessão; matriz de aceite e consolidação continuam abertas. Nenhuma implementação,
  instalação, credencial, experimento ou prova de runtime executada.
- Validação documental: `git diff --check`; metadados/tipos/labels, dependências sem ciclos e pré-requisitos resolvidos dos 25 tickets;
  índice de resoluções do mapa; 237 links locais e respectivas âncoras nos 14 arquivos alterados; única fronteira aberta é a matriz de aceite,
  e nenhuma spec antecipada foi criada. Não houve testes de runtime ou alegação de homologação.

## Answer

### Conclusão da revisão

A composição documental é coerente para prosseguir à definição do aceite, **com os ajustes confirmados nesta revisão**.
Não surgiu necessidade de outro motor, banco, coletor documental, ferramenta de logs, publicador ou supervisor.
Isso não certifica integração, segurança, capacidade, menor custo ou cumprimento empírico do PRD.

Permanecem válidas as escolhas de Pi Durable/SQLite como autoridade, workers Pi independentes do perfil pessoal,
Gondolin QEMU/KVM por Trabalho, supervisão dos ambientes, publicação direta via App, lease/reconciliação,
handoff dos dois revisores, controle de prontidão e manutenção, CLI local e retenção conservadora.
O [asset de análise](../architecture-cross-review.md#composição-após-os-ajustes-confirmados) relaciona as fronteiras examinadas
e os contratos correspondentes, sem substituir seus Answers.

### Ajustes aprovados e registros canônicos

| Ajuste | Justificativa e registro final |
| --- | --- |
| Memória mínima após exclusão | Preservar a avaliação de dependências próprias sem reter o histórico excluído; regra final em [observabilidade e retenção](22-observability-retention-contract.md#limpeza-explícita-exclusão-do-histórico-e-cópias-externas), consumida por [dependências](09-dependency-compatibility.md#enumeração-grafo-e-satisfação) e [CLI](21-installation-operations-contract.md#limpeza-e-exclusão). |
| Continuação após parada administrativa limpa | Não confundir manutenção normal com recuperação por falha; classificação/cobrança em [estados e efeitos](08-state-and-effects-contract.md#limites-falhas-e-tempo), referenciada por operação e protocolo, sem retirar reconciliação ou limites. |
| Leitura de saídas longas pelos agentes | Tornar a referência utilizável sem expor registros host ou aceitar cópia editável como prova de gate; regra final em [observabilidade](22-observability-retention-contract.md#saídas-volumosas-e-falhas-de-gravação), consumida pelo adapter. |
| Fonte documental privada inacessível | Evitar coletor e ampliação de credenciais para cumprir promessa anterior incompatível com a captura escolhida; regra final em [especificação](16-specification-snapshot-contract.md#fontes-indisponíveis-e-conteúdo-posterior), com a promessa retirada no contrato da App. Leitura de dependências nativas permanece distinta. |

Detalhes normativos vivem nesses registros canônicos; a revisão registra a composição e a autorização dos ajustes,
não uma segunda versão de cada contrato.

### Alinhamentos com a operação já decidida

Aplicar o [contrato operacional](21-installation-operations-contract.md#answer), sem nova escolha de escopo:

- Remover de durabilidade, estados, protocolo e encaminhamentos do adapter exigências de backup/restauração integrado.
  Permanecem recovery após crash, compatibilidade/migração explícitas e recuperação definida para migração interrompida.
- Alinhar isolamento/estados com controlador em primeiro plano ou serviço opcional; systemd dos ambientes continua obrigatório.
- Alinhar adapter/observabilidade com conta dedicada recomendada, não obrigatória, e confiança explícita nos processos da conta usada.
- Preservar instalação autocontida sem promessa de relocação livre, perfil de release fixado e configuração de sandbox encapsulada.

Esses ajustes corrigem redações anteriores; não reabrem escolha de backend, limites de credenciais ou responsabilidade do time operador
pelas barreiras GitHub. O histórico das confirmações permanece preservado.

### Limites, validação futura e próxima fronteira

Os contratos aprovados continuam sujeitos às provas descritas neles. Aprovação documental não demonstra SQLite FULL,
barreira do scheduler, cessação, filtragem antes de persistência SDK, Docker/TLS/FUSE, permissões GitHub, visibilidade de dependências
ou capacidade de três Builders. Não introduzir certificação de barreiras da App ou backup integrado como gates indiretos.

[Definir a matriz de aceite e a sequência de validação incremental](24-acceptance-and-incremental-plan.md) passa a ser a próxima fronteira:
conferir RF-01–14, RNF-01–05 e CA-01–12, incorporando também os quatro ajustes desta revisão.
[Consolidar a spec técnica implementável do MVP](25-consolidate-technical-spec.md) continua bloqueada pela matriz de aceite.
Nenhum novo ticket é necessário neste fechamento; novas lacunas identificadas na matriz ou na consolidação exigem decisão própria,
não preenchimento por suposição. O mapa permanece aberto.
