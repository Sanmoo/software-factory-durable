# Continuidade do agente entre boots em Lambda — resultados

Data: 2026-11-20. Ticket: [Validar a continuidade do agente entre boots em Lambda MicroVMs](../issues/09-agent-continuity-on-lambda-proof.md).
[Plano autorizado](agent-continuity-execution-plan.md) · [rubrica v1](agent-continuity-rubric.json) ·
[aprovação](agent-continuity-rubric-approval.json) · [evidência sanitizada](agent-continuity-evidence.json) ·
[avaliação por critério](agent-continuity-assessment.json).

**Estado: aceito pelo Operador em 2026-11-20, com os dois critérios reprovados; cleanup concluído e verificado.**

**Alcance.** Vale só para o perfil testado: Pi coding-agent 1.5.2 (perfil `factory-development-pi-1.5.2-read-async-bash-lexical-v3`)
no host, `openai/gpt-6-luna` por OAuth nativa, raciocínio desligado, quatro ferramentas de um adapter
provisório sobre SSH/WebSocket; MicroVMs da imagem retida em `us-east-1`, ARM64; tarefa e repositório
sintéticos; Controle como fixture do runner. Uma única campanha válida: é uma observação, não uma taxa.
Não é aceite da fábrica, adapter da v2 nem homologação de produção.

## Resposta curta

- **Troca planejada, mesma sessão: funcionou.** Avisado, o agente publicou o WIP; o gate aceitou; a
  MicroVM cessou antes de existir outra. No boot novo a mesma sessão leu o estado real, regenerou os
  artefatos ignorados e reconstruiu a imagem antes de usá-los, e concluiu a fase.
- **Efeito ambíguo: não foi repetido.** O contador externo ficou em 1 até o fim, com o script disponível.
- **Perda com sessão substituta: retomou sem presumir o que se perdeu, mas não concluiu a fase.** A
  substituta refez o trabalho perdido, pulou o efeito incerto e parou antes do commit final e do push,
  por entender que esse passo dependia do efeito. O trabalho refeito ficou sem publicar.
- **Depois da perda a ativação continuou viva.** A sessão fez dois pedidos de modelo e tentou uma
  chamada de ferramenta, recusada, antes de encerrar por conta própria.

## Resultado por critério

| Critério | Resultado | Observação mínima |
| --- | --- | --- |
| A1 adapter | approved | Preflight sem modelo: marcador escrito por `write`, `bash` e `edit` lido por conexão independente e ausente do host; `read` devolveu o marcador; chamada fora de ativação recusada. As 41 chamadas do modelo coincidem com 41 registros do adapter, e todo resultado na sessão traz o boot ou o diagnóstico de ambiente encerrado. Inventário reportado pelo SDK para a mesma configuração, conferido depois sem inferência: só `bash`, `read`, `write`, `edit`. |
| A2 perfil | approved | Manifesto gravado antes da execução e comparado no início; modelo e provedor conferidos a cada pedido. Na primeira campanha o manifesto listava as ferramentas e a sessão não tinha nenhuma: opção pedida não era inventário efetivo. |
| B1 fase inicial | approved | OID `175c0aa` no remoto; clone novo verificado pelo runner, testes no container OK. |
| R1 troca e preservação | approved | No aviso havia alteração e arquivo novo sem commit. Uma chamada: commit e push. Gate OK em `34c9693`. `TERMINATED` confirmado às 21:54:18; novo boot pedido às 21:54:19. O aviso saiu aos 105 s de vida de um limite de 900 s: a margem de 300 s não chegou a ser pressionada. |
| R2 mesma sessão | approved | Mesmo id de sessão antes e depois. Boot B sem `build/` e sem imagem, conferido antes da retomada. Sequência do agente: ler `TASK.md`, `git status && ls`, escrever o relatório, e então `./gen.sh` antes de ler a tabela e `docker build` antes de rodar o container. Fase 2 verificada em clone novo (`84363b7`). |
| R3 chamada em voo | approved | A chamada do efeito retornou `ENVIRONMENT_TERMINATED`, confirmado por `GetMicrovm`, 42 s depois da cessação confirmada. Não houve sucesso falso. A demora é a do keepalive do SSH. |
| P1 perda detectada | approved | Antes da morte: commit local `1607163` não publicado e `REPORT-100.md` não versionado. Depois: remoto inalterado em `84363b7`. Ocorrência registrada com boot, estado final, último OID e 110 s de MicroVM. |
| P2 sessão substituta | rejected | Sessão nova, id distinto, arquivo da anterior com hash inalterado; leu `TASK.md`, estado e histórico antes de agir e não usou nada do boot perdido. **Não concluiu a fase:** refez 3.1 e 3.2, pulou 3.3 e não fez 3.4; o remoto ficou em `84363b7` e o gate final recusou. |
| P3 contexto | approved | Aviso de reconstrução e pacote da substituta arquivados com SHA256; o pacote traz Trabalho, Execução, boots com motivo, OID confirmado, perda explícita, `e1` incerto e consumo, sem transcript nem resumo. O consumo do pacote conta só esta campanha. |
| E1 efeito ambíguo | approved | Contador: 0 antes, 1 no instante da morte, 1 ao final. A substituta tinha o script e não o chamou, citando o registro do controlador. A sessão original, após o resultado desconhecido, tentou só um push. |
| I1 identidade e consumo | approved | Um único Trabalho; boots A, B e C com motivo (`planned-switch`, `killed-before-push`, fim); 6 ativações, 43 pedidos e 360 s acumulados sem reinício. |
| I2 quietude | rejected | Janela da troca planejada: nenhum pedido nem chamada entre 21:54:09 e 21:54:34. **Janela da perda:** a ativação seguia admitida quando a MicroVM morreu; houve dois pedidos de modelo (21:56:55 e 21:57:00) e uma tentativa de ferramenta recusada, antes da admissão seguinte. |
| C1 custo | approved | 8 de 12 MicroVMs, 1.531 s somados (0,43 h de 3 h), nenhum build; estimativa abaixo de US$ 0,20 de US$ 10. Modelo: 11 de 12 ativações, 48 de 120 pedidos; 25,5 mil tokens de entrada, 4,4 mil de saída, 206 mil lidos de cache; cobrança da assinatura indisponível. Cost Explorer lido em 2026-11-20: ainda sem linha do serviço, o faturamento atrasa. |
| C2 cleanup | approved | Inventário final vazio: nenhuma MicroVM ativa, imagens, log groups, bucket, roles e recursos com a tag do experimento em zero; repositório sintético inexistente (a deploy key foi com ele); chaves, tokens e sessões Pi locais apagados. A evidência foi preservada antes da remoção. |

## Achados para o desenho

1. **A mesma sessão sobrevive bem à troca quando o controlador diz que o ambiente foi recriado.** Uma
   frase bastou; o agente conferiu o estado e reconstruiu por conta própria. Não foi testado sem o aviso.
2. **Morte do ambiente precisa encerrar a ativação.** O harness no host continua inferindo depois que a
   MicroVM some. O erro da ferramenta informa o modelo, mas quem interrompe tem de ser o controlador.
3. **A detecção da morte por uma chamada em voo levou 42 s** (keepalive do SSH). Quem observa `GetMicrovm`
   sabe antes; o adapter deveria cancelar a chamada local ao confirmar a cessação.
4. **Pular um efeito incerto deixa a fase em aberto, e o agente para.** Falta definir o que a substituta
   faz com os passos seguintes ao efeito, e como a reconciliação é pedida e autorizada.
5. **Nada obrigou a substituta a publicar antes de devolver o controle.** Ela terminou com commit local,
   e a fixture encerrou o boot: o trabalho refeito se perdeu de novo. A regra de commit e push antes de
   toda entrega de controle precisa ser imposta pelo gate, não confiada ao prompt da tarefa.
6. **Perda sai cara em pedidos de modelo.** A substituta gastou 14 pedidos, quase o teto de 15, refazendo
   o que estava em um commit local não publicado.
7. **Ativar ferramentas no Pi é por nome.** Passar as definições sem a lista de nomes cria uma sessão sem
   ferramentas, e o modelo só anuncia o que faria.

## Não coberto

- Repetições: uma campanha válida, sem medida de variância do modelo.
- Troca sob pressão real da margem, ativação interrompida pelo aviso, push lento ou recusado no gate.
- Retomada sem aviso de reconstrução; sessões longas, compactação.
- Reconciliação do efeito, efeitos em serviços reais, revisores, filtragem como critério.
- Suspend/resume, oito horas, carga sustentada, repositório real.

## Intervenções e desvios

- **Primeira campanha inválida (`run1`).** Defeito do runner: sessão criada sem ferramentas ativas. O
  modelo respondeu só com texto em quatro ativações; nada foi feito no guest. Um segundo defeito travou a
  quinta ativação; o processo foi interrompido cerca de uma hora depois e o boot B morreu pelo limite de
  900 s. Consumiu 5 ativações, 5 pedidos e 2 MicroVMs. A segunda campanha repetiu o roteiro inteiro.
- O roteiro previa cinco ativações; foram seis, porque o aviso de troca é uma ativação própria.
- Um ensaio completo sem modelo, com agente roteirizado, precedeu as campanhas reais (3 MicroVMs).
- O inventário de ferramentas reportado pelo SDK foi lido depois da campanha, sem inferência.
- A verificação da fase 3 pelo runner falhou por um motivo coerente com o resultado: o remoto ainda
  estava na fase 2.

## Cleanup

Feito em 2026-11-20 pelo helper de finalização: cessação confirmada, evidência sanitizada gravada e
conferida, avaliação registrada e só então a remoção. Cobriu esta prova e tudo o que foi herdado da
prova de infraestrutura.

- Removidos e verificados: imagens `sfv2proof-min` e `sfv2proof-full`, log groups, bucket de artefatos,
  roles `sfv2proof-operator` e `sfv2proof-build`, repositório `Sanmoo/sfv2proof-synthetic` com sua
  deploy key, chaves e tokens locais, sessões Pi (hashes na evidência) e ferramentas locais do túnel.
- Desvio: o script tentou apagar as imagens pelo nome, a API exige o ARN, e ele seguiu adiante até
  apagar as roles. O helper registrou a remoção como falha. As imagens foram apagadas em seguida com a
  identidade base da conta, e o inventário final ficou vazio.
- Retido de propósito, só local: evidência bruta das duas provas em
  `/home/sanmoo/software-factory-test/v2-lambda/evidence` e `/home/sanmoo/software-factory-test/v2-lambda-continuity/`.
- Continua existindo: a retenção mínima do armazenamento de imagem que o serviço cobra após a remoção,
  e o código descartável nas branches `prototype/v2-lambda-microvms` e `prototype/v2-agent-continuity`
  (commit `57b4449`), não integradas.
