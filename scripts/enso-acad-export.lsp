;;; ===================================================================
;;; enso-acad-export.lsp — выгрузка DWG для моста Claude MCP
;;;
;;; Установленный claude-acad-bridge.lsp умеет РИСОВАТЬ в открытом чертеже,
;;; но записать отдельный DWG не умеет: в его каталоге нет ни export_dwg,
;;; ни WBLOCK, ни SAVEAS. Из-за этого Enso-nexus получал от моста
;;; «Неизвестный метод: export_dwg» и откатывался на конвертер LibreDWG.
;;;
;;; Этот файл добавляет мосту недостающую команду. Сам мост он НЕ меняет:
;;; только дописывает одну запись в его реестр *acmcp-commands*. Поэтому
;;; обновление коннектора ничего здесь не сломает, а чтобы отказаться —
;;; достаточно убрать файл из автозагрузки.
;;;
;;; Установка: APPLOAD → выбрать этот файл → Load, затем
;;;            Contents… → Add (чтобы грузился при каждом запуске).
;;; Грузить ТОЛЬКО после claude-acad-bridge.lsp — он опирается на его
;;; вспомогательные функции.
;;;
;;; Метод: export_dwg
;;;   params: { "path": "/…/файл.dwg", "handles": ["1A2", "1A3", …] }
;;;   result: { "path": …, "exported_count": N, "warnings": [] }
;;; ===================================================================

(defun acmcp:export-dwg (params / path handles ss e n missing)
  (setq path (jo-str params "path" nil))
  (if (or (null path) (= path ""))
    (acmcp-fail -32602 "Не хватает пути к файлу DWG"))
  (setq handles (acmcp-handles-arr params "handles"))

  ;; Набор строится по handle: выгружаем ровно то, что построил мост,
  ;; и ничего из того, над чем работает человек.
  (setq ss (ssadd) n 0 missing nil)
  (foreach h handles
    (if (setq e (acmcp-ent h))
      (progn (ssadd e ss) (setq n (1+ n)))
      (setq missing (cons h missing))))
  (if (= n 0)
    (acmcp-fail -32005 "Ни один из переданных handle не найден — выгружать нечего"))

  ;; -WBLOCK спросил бы о замене существующего файла, а отвечать некому
  (if (findfile path) (vl-file-delete path))

  ;; FILEDIA = 0 нужен, чтобы -WBLOCK спрашивал имя файла в командной строке,
  ;; а не открывал диалог. Ставим через безопасный установщик моста: прямой
  ;; setvar эта сборка AutoCAD отклоняет ошибкой «variable setting rejected»,
  ;; и весь вызов падал на ровном месте. CLAUDE-PUMP выставляет FILEDIA сам
  ;; и возвращает прежнее значение после работы, так что отказ здесь не страшен.
  (acmcp-setvar-safe "FILEDIA" 0)

  ;; Последовательность подсказок -WBLOCK:
  ;;   имя файла → Enter (создать новый чертёж) → точка вставки → набор → Enter
  (command "_.-WBLOCK" path "" "0,0,0" ss "")

  (if (not (findfile path))
    (acmcp-fail -32003 (strcat "AutoCAD не записал файл: " path)))

  (j:o (list (cons "path" (j:s path))
             (cons "exported_count" (j:n n))
             (cons "undo_group" (j:s "MCP: выгрузка DWG"))
             (cons "warnings"
                   (j:a (if missing
                          (list (j:s (strcat "Не найдено handle: " (itoa (length missing)))))
                          nil))))))

;;; -------------------------------------------------------------------
;;; create_hatch_holes — штриховка кольцевой зоны
;;;
;;; Штатный create_hatch заливает ОДИН контур. Зона отступа — кольцо вдоль
;;; границы участка, и без выреза она закрашивается на весь участок: чертёж
;;; показывает запрещённым то, что разрешено. DXF это уже умеет (несколько
;;; путей границы у HATCH), а DWG отставал.
;;;
;;; params: как у create_hatch, плюс "holes": [[{x,y},…], …]
;;; -------------------------------------------------------------------

(defun enso-poly (pts layer)
  (entmake (append
             (list '(0 . "LWPOLYLINE") '(100 . "AcDbEntity"))
             (acmcp-8 layer)
             (list '(100 . "AcDbPolyline") (cons 90 (length pts)) '(70 . 1) '(43 . 0.0))
             (mapcar '(lambda (p) (cons 10 (list (car p) (cadr p)))) pts)))
  (entlast))

(defun acmcp:create-hatch-holes (params / pts holes pattern scale angle layer keep
                                 ss ebound bents hh news hl hpts)
  (setq pts (mapcar 'jv-pt (jo-arr params "boundary_points"))
        holes (jo-arr params "holes")
        pattern (jo-str params "pattern" "ANSI31")
        scale (jo-num params "scale" 1)
        angle (jo-num params "angle_deg" 0)
        layer (acmcp-check-layer (jo-str params "layer" nil))
        keep (jo-bool params "keep_boundary" nil))
  (if (< (length pts) 3) (acmcp-fail -32003 "Нужно минимум 3 точки контура"))
  (if (<= scale 0) (acmcp-fail -32003 "scale должен быть > 0"))

  (setq ss (ssadd) bents nil)
  (setq ebound (enso-poly pts layer))
  (ssadd ebound ss)
  (setq bents (list ebound))

  ;; каждое отверстие — свой замкнутый контур; островки -HATCH вырежет сам
  (foreach hl holes
    (setq hpts (mapcar 'jv-pt (if (and hl (= (car hl) 'J:ARR)) (cdr hl) hl)))
    (if (>= (length hpts) 3)
      (progn
        (setq ebound (enso-poly hpts layer))
        (ssadd ebound ss)
        (setq bents (cons ebound bents)))))

  (if layer (setvar "CLAYER" layer))
  (command "._-hatch" "_properties" pattern scale angle "_select" ss "" "")
  (setq news (acmcp-new-handles ebound))
  (if (null news) (acmcp-fail -32603 "Команда -HATCH не создала штриховку"))
  (setq hh (car news))

  ;; контуры — строительные леса: в чертеже остаются только по явной просьбе
  (if (not keep) (foreach e bents (entdel e)))

  (acmcp-created (strcat "штриховка " pattern " с отверстиями: " (itoa (length holes)))
                 (if keep (cons hh (mapcar 'acmcp-handle bents)) (list hh))
                 (list (cons "hatch"
                             (j:o (list (cons "handle" (j:s hh))
                                        (cons "pattern" (j:s pattern))
                                        (cons "holes" (j:n (length holes)))))))))

;; Регистрация в реестре моста. Идёт в конец списка, существующие команды
;; не трогаются; повторная загрузка файла дубля не создаёт.
(if (not (boundp '*acmcp-commands*))
  (princ "\n[enso] claude-acad-bridge.lsp не загружен — сначала загрузите его")
  (progn
    (foreach name (list "export_dwg" "create_hatch_holes")
      (if (assoc name *acmcp-commands*)
        (setq *acmcp-commands*
              (vl-remove-if '(lambda (r) (= (car r) name)) *acmcp-commands*))))
    (setq *acmcp-commands*
          (append *acmcp-commands*
                  (list (list "export_dwg" T 'acmcp:export-dwg)
                        (list "create_hatch_holes" T 'acmcp:create-hatch-holes))))
    (princ "\n[enso] в мост Claude MCP добавлены команды: export_dwg, create_hatch_holes")))
(princ)
