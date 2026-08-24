# baseline検証結果

改善前の現象は当日runで再現した。

- fresh環境の`local:start`はmigration不足をprepare前に拒否した。
- `local:prepare`初回成功出力は3,544行だった。
- 不正な`work-type`は成功扱いのまま保存結果から消えた。
- connectorの`--cli-path`は登録計画に反映されなかった。
- Mapは描画後も読み込み中のstatusを残した。
- Skill下書きは生成できたが、focus移動、非公開状態、次操作が不足した。

改善後の回帰結果は`../improved/test-results.md`に記録した。
