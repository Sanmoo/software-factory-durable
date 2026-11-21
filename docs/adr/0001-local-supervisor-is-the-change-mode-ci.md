# 0001. A validação por mudança roda no supervisor local, não no GitHub Actions

Status: aceita (adoção do engineering harness, 2026-11-21).

**Contexto.** O gate de integração já era `npm run test:ci`, rodado localmente sob o lock da máquina antes de entregar e de novo após rebase; o GitHub Actions roda só checagens documentais. Muitos testes dependem de processos reais, KVM e da preparação privada do SDK desta máquina.

**Decisão.** O modo de validação por mudança do Entry Point completo é a execução local do supervisor, e a validação integral é o timer systemd noturno. O GitHub Actions mantém apenas o job documental.

**Razão.** Mover a suíte para runners hospedados exigiria reproduzir o ambiente local e mudaria o fluxo de integração; o custo não compra proteção nova. A cadência integral é conferida contra o `OnCalendar` do timer versionado, não contra um workflow.
