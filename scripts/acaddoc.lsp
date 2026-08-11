;; Автозагрузка моста Claude MCP и расширения Enso-nexus.
;; Файл лежит в @en@/Support — папке, которая ДЕЙСТВИТЕЛЬНО входит в пути
;; поиска AutoCAD. В roaming/Support (где он был раньше) AutoCAD не заглядывает,
;; поэтому автозагрузка молча не срабатывала и мост приходилось грузить руками.
;; Пути всё равно полные: так файл работает и при смене путей поиска.

(setq *enso-support*
      (strcat (getenv "HOME")
              "/Library/Application Support/Autodesk/AutoCAD 2027/R26.0/roaming/@en@/Support/"))

;; отметка о выполнении — по ней проверяется, что автозагрузка живая
(defun enso-mark (text / f)
  (if (setq f (open "/tmp/enso-acaddoc.log" "a"))
    (progn (write-line text f) (close f))))

(enso-mark "acaddoc.lsp выполнен")

(if (findfile (strcat *enso-support* "claude-acad-bridge.lsp"))
  (progn
    (load (strcat *enso-support* "claude-acad-bridge.lsp"))
    (enso-mark "мост загружен")
    (if (findfile (strcat *enso-support* "enso-acad-export.lsp"))
      (progn
        (load (strcat *enso-support* "enso-acad-export.lsp"))
        (enso-mark "расширение загружено")))))

;; Режим сервера при открытии чертежа — только если в папке обмена лежит флаг
;; AUTOSERVE. По умолчанию его нет: цикл опроса блокирует AutoCAD, и включать
;; его без спроса нельзя.
(defun S::STARTUP ()
  (if (findfile (strcat (getenv "HOME")
                        "/Library/Application Support/ClaudeAcadMCP/exchange/AUTOSERVE"))
    (c:CLAUDE-SERVE)))
(princ)
