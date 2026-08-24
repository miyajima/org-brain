# Baseline findings

優先順位は、重大度、重点軸の点差、影響flow数、修正規模の順で決めた。

1. high: fresh Local startがmigration不足で停止。
2. high: connectorの指定CLI pathが無視される。
3. high: Local connectorの初回完遂不能。
4. medium: Mapの描画完了とstatusが矛盾。
5. medium: prepare出力が3,544行。
6. medium: SQLite権限エラーに直接復旧がない。
7. medium: 不正work-typeが成功扱い。
8. medium: Skill生成後の完了位置と次操作が曖昧。
9. medium: Cloud live、AI parity、team revoke/auditが未検証。

詳細とfinding IDはbaselineの`measurement-input.json`を正本とする。
