# Evidência 36: runner de testes em camadas

Máquina: 8 núcleos, Node 24.21.0, 2026-11-15, base a2f0a76. Outras sessões carregavam a máquina; a carga
(`uptime`) está ao lado de cada tempo. Relatórios do runner em [36-runs/](36-runs/).

| Execução | Total (teto) | Espera no lock | Carga início → fim | Resultado |
| --- | --- | --- | --- | --- |
| `fast` | 96,4 s (180 s) | — | 1,28 → 4,31 | 1029 pass, 10 skip |
| `ci` 1 | 179,8 s (600 s) | 0,0 s | 3,65 → 13,46 | 1118 pass, 10 skip |
| `ci` 2 (lançada 3 s após a 1) | 182,7 s (600 s) | 176,8 s | 13,46 → 14,57 | 1118 pass, 10 skip |
| `ci` 3 | 223,1 s (600 s) | 0,0 s | 14,57 → 15,59 | 1118 pass, 10 skip |

Duas rodadas anteriores de três `ci` (antes da quarentena de `admission-cli` e do `serial` de
`bash-credential`) deram 2 vermelhos cada, só nesses dois arquivos; ver ticket 36 e comentário no 37.
