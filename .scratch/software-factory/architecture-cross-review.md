# Análise de compatibilidade da arquitetura

Asset de [Revisar a composição da arquitetura e suas fronteiras](issues/23-architecture-cross-review.md).
A resolução e o índice dos ajustes estão no Answer desse ticket; este arquivo registra o cruzamento documental, não uma segunda spec.

## Base e limites

Leitura do PRD e dos Answers de autoridade, durabilidade, runtime, isolamento, estados, dependências, prontidão, App,
protocolo, especificação, skills, adapter, manutenção, observabilidade e operação. Base inicial: commit `4fb26da` de `main`.
As pesquisas concluídas foram consideradas por suas referências nos contratos; não houve nova pesquisa, implementação ou prova de runtime.

## Composição após os ajustes confirmados

| Fronteira | Compatibilidade documental observada | Contratos |
| --- | --- | --- |
| Autoridade e persistência | Pi Durable/SQLite é proprietário de autorização/fila/orçamento; sessões, logs e recibos são evidências, não outra autoridade. CLI acessa esse proprietário. | [Durabilidade](issues/02-durability-strategy.md), [estados](issues/08-state-and-effects-contract.md), [operação](issues/21-installation-operations-contract.md) |
| Admissão e capacidade | Reserva durável precede spawn; início confirmado cobra orçamento; Slot só é liberado após cessação. Revisores compartilham Slot sem Builder ativo em paralelo. | [Estados](issues/08-state-and-effects-contract.md), [protocolo](issues/15-controller-worker-protocol.md) |
| Recovery e supervisão | Lock exclui outro controlador, não mata workers. Barreira de boot, descoberta por identidade e cessação supervisionada precedem substituição; adapter encapsula systemd/QEMU. | [Protocolo](issues/15-controller-worker-protocol.md), [adapter](issues/19-gondolin-adapter-contract.md) |
| Publicação e permissões | Builder publica diretamente; protocolo retirou intenção específica por push/PR, sem dispensar lease e reconciliação. A App não vira credencial universal de contexto. | [Autoridade](issues/01-control-authority.md), [App](issues/11-github-app-contract.md), [protocolo](issues/15-controller-worker-protocol.md) |
| Autorização e escopo | Label autoriza entrada; retirada observada suspende novas ativações. Resposta, concessão de orçamento e renovação de escopo não se substituem. | [Estados](issues/08-state-and-effects-contract.md), [especificação](issues/16-specification-snapshot-contract.md), [operação](issues/21-installation-operations-contract.md) |
| Revisão e prontidão | Pareceres ligados ao conteúdo; commit idêntico não causa revisão redundante; recuperação parcial requer contexto inalterado. CI continua vinculado ao SHA pertinente. | [Prontidão](issues/10-readiness-checks-contract.md), [skills](issues/17-skills-and-review-contract.md), [adapter](issues/19-gondolin-adapter-contract.md) |
| Manutenção | Gatilhos efetivos, feedback consolidado e encerramento da correção sem esperar CI; mero avanço da base não dispara manutenção. | [Prontidão](issues/10-readiness-checks-contract.md), [manutenção](issues/20-pr-maintenance-contract.md) |
| Configuração e operação | Recursos/perfil no adapter; primeiro plano não dispensa supervisão dos ambientes; conta pessoal não amplia ferramentas do guest; atualização não pressupõe backup integrado. | [Isolamento](issues/07-isolation-choice.md), [adapter](issues/19-gondolin-adapter-contract.md), [operação](issues/21-installation-operations-contract.md) |
| Retenção e acesso às evidências | Cessação e ownership antecedem remoção; contexto acessível ao agente não expõe registros host; memória mínima preserva avaliação de dependência própria. | [Dependências](issues/09-dependency-compatibility.md), [observabilidade](issues/22-observability-retention-contract.md) |

## Achados que motivaram a rodada HITL

Os quatro achados abaixo descrevem as lacunas na base inicial, não defeitos ainda abertos. O operador aprovou as recomendações;
as regras finais vivem nos contratos canônicos apontados pelo Answer da revisão.

| Achado inicial | Consequência que precisava de decisão |
| --- | --- |
| Exclusão preservava identidade antirredisparo sem explicitar o fato de entrega | Dependência própria poderia perder comprovação de merge ou ser confundida com externa. |
| Parada administrativa tinha cessação, mas não classificação explícita da cobrança posterior | Manutenções normais poderiam consumir o limite destinado a falhas operacionais. |
| Saída longa tinha referência host, mas leitura dos agentes era confinada ao guest | Trecho truncado poderia apontar a arquivo inacessível ao papel. |
| App prometia busca de fontes privadas, enquanto captura posterior retirava coletor do controlador | A composição exigiria uma integração não decidida ou ampliação indevida de credencial. |

Também foram encontrados trechos anteriores ainda impondo backup integrado, conta dedicada e serviço do controlador.
O alinhamento aplica a decisão operacional já aprovada, sem substituir systemd dos ambientes nem prometer relocação da instalação.

## Limites e encaminhamento

Compatibilidade documental não demonstra funcionamento. Permanecem futuras as provas de SQLite FULL, scheduler/barreira,
SDK/filtragem, supervisão/cessação, Gondolin/Docker/FUSE/TLS, GitHub/visibilidade/regras, recuperação e capacidade real.
Manifestos/versões finais continuam obrigações da construção da release, não números inventados para fechar o desenho.

A cobertura integral e a sequência das provas pertencem a
[Definir a matriz de aceite e a sequência de validação incremental](issues/24-acceptance-and-incremental-plan.md).
A spec pertence a [Consolidar a spec técnica implementável do MVP](issues/25-consolidate-technical-spec.md).
Não houve nova lacuna autônoma identificada após os quatro ajustes; qualquer incompatibilidade futura exige retorno ao operador,
não relaxamento silencioso do PRD.
