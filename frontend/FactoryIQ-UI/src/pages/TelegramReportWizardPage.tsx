import React, { useState } from "react";
import styles from "../styles/TelegramReportWizardPage.module.css";
import { CheckCircle, Loader, ChevronRight, Send, Plus } from "lucide-react";
import BackButton from "../components/BackButton";
import logo from "../../assets/images/logo.jpeg";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

const stepsData = [
  {
    label: "Выбрать/создать шаблон отчёта",
    desc: "Задайте структуру будущего отчёта (теги, формат)",
  },
  {
    label: "Выбрать Telegram-канал",
    desc: "Укажите канал или чат для отправки отчёта",
  },
  {
    label: "Настроить расписание",
    desc: "Когда и как часто отправлять отчёт (ежедневно, по сменам и т.д.)",
  },
  {
    label: "Формат отправки",
    desc: "Выберите тип отправки — файл, текст, таблица, график",
  },
  {
    label: "Предпросмотр и тест",
    desc: "Проверьте, как будет выглядеть сообщение в Telegram",
  },
  {
    label: "Сохранить и включить",
    desc: "Готово! Задача будет выполняться автоматически",
  },
];

const mockFormats = [
  { value: "file", label: "Excel-файл" },
  { value: "table", label: "Таблица (текст)" },
  { value: "chart", label: "График" },
];

const TelegramReportWizardPage: React.FC = () => {
  const [step, setStep] = useState(1);
  const [completed, setCompleted] = useState<number[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<null | { ok: boolean; message: string }>(
    null
  );

  // Выборы пользователя
  const [selectedTemplate, setSelectedTemplate] = useState<number | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<number | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<string>("file");
  const [previewText, setPreviewText] = useState<string>("");

  const [templates, setTemplates] = useState<any[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const navigate = useNavigate();
  const [channels, setChannels] = useState<any[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [scheduleType, setScheduleType] = useState("daily");
  const [scheduleTime, setScheduleTime] = useState("08:00");
  const [aggregationType, setAggregationType] = useState("avg"); // for hourly
  const [showAddChannelModal, setShowAddChannelModal] = useState(false);
  const [newChannelId, setNewChannelId] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [newThreadId, setNewThreadId] = useState("");
  const [sendAsFile, setSendAsFile] = useState(true);
  const [sendAsText, setSendAsText] = useState(false);
  const [sendAsChart, setSendAsChart] = useState(false);
  const [addingChannel, setAddingChannel] = useState(false);
  const [addChannelError, setAddChannelError] = useState("");

  const handleAddChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddingChannel(true);
    setAddChannelError("");
    try {
      const resp = await fetch("http://localhost:8000/telegram/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_id: newChannelId,
          channel_name: newChannelName,
          thread_id: newThreadId ? Number(newThreadId) : null,
          send_as_file: sendAsFile,
          send_as_text: sendAsText,
          send_as_chart: sendAsChart,
          active: true,
        }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        setAddChannelError(data.detail || "Ошибка добавления канала");
        setAddingChannel(false);
        return;
      }
      // обновить список каналов
      fetch("http://localhost:8000/telegram/channels")
        .then((res) => res.json())
        .then((data) => setChannels(data.channels || []));
      setShowAddChannelModal(false);
      setNewChannelId("");
      setNewChannelName("");
      setNewThreadId("");
      setSendAsFile(true);
      setSendAsText(false);
      setSendAsChart(false);
    } catch (e) {
      setAddChannelError("Сетевая ошибка: " + (e as any)?.message);
    }
    setAddingChannel(false);
  };

  useEffect(() => {
    setLoadingTemplates(true);
    fetch("http://localhost:8000/reports/templates")
      .then((res) => res.json())
      .then((data) => setTemplates(data.templates || []))
      .finally(() => setLoadingTemplates(false));
  }, []);

  // Автопрогрессия шага после выбора (для UX)
  const nextStep = () => {
    setCompleted((prev) => [...new Set([...prev, step])]);
    setStep((s) => Math.min(s + 1, stepsData.length));
  };

  // Хендлеры выбора (имитируем переход к следующему шагу)
  const handleSelectTemplate = (id: number) => {
    setSelectedTemplate(id);
    nextStep();
  };

  useEffect(() => {
    // Загружаем каналы при переходе на шаг 2
    if (step === 2) {
      setChannelsLoading(true);
      fetch("http://localhost:8000/telegram/channels")
        .then((res) => res.json())
        .then((data) => {
          if (data.ok) setChannels(data.channels);
          else setChannels([]);
        })
        .catch(() => setChannels([]))
        .finally(() => setChannelsLoading(false));
    }
  }, [step]);

  const handleSelectChannel = (channelId: number) => {
    setSelectedChannel(channelId);
    nextStep();
  };

  // В состоянии компонента:

  const handleSaveSchedule = async () => {
    let timeOfDay = "";
    let meta = {};
    if (scheduleType === "daily") {
      timeOfDay = scheduleTime;
    } else if (scheduleType === "shift") {
      timeOfDay = "08:00, 20:00";
    } else if (scheduleType === "hourly") {
      timeOfDay = ""; // или можно время старта
      meta.aggregation = aggregationType;
    } else if (scheduleType === "once") {
      timeOfDay = new Date().toISOString().slice(11, 16); // "HH:MM"
    } else if (scheduleType === "exceed") {
      timeOfDay = "";
      meta.norm_id = null; // или id выбранной нормы
    }
    // Далее делаем POST на /reports/schedule
    await fetch("http://localhost:8000/telegram/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: selectedTemplate,
        period_type: scheduleType,
        time_of_day: timeOfDay,
        target_type: "telegram",
        target_value: selectedChannel,
        meta: Object.keys(meta).length ? JSON.stringify(meta) : null,
      }),
    });
  };

  const handleSelectFormat = (value: string) => {
    setSelectedFormat(value);
    nextStep();
  };
  const handlePreview = async () => {
    setIsLoading(true);
    try {
      // Пример запроса на предпросмотр (формирует данные как в реальном отчёте)
      const resp = await fetch("http://localhost:8000/reports/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template_id: selectedTemplate,
          format: selectedFormat,
          period_type: scheduleType,
          time_of_day: scheduleTime,
          // возможно нужно еще канал для корректного рендера,
        }),
      });
      const data = await resp.json();
      if (data.ok) {
        if (selectedFormat === "chart") {
          // Можно отрисовать chart по data.chartData или base64 PNG
          setPreviewText("");
          // ... setChartData(data.chartData);
        } else if (selectedFormat === "file") {
          setPreviewText(
            "В Telegram будет отправлен Excel-файл.\n(Показать здесь предпросмотр файла невозможно, но данные сформированы)"
          );
        } else {
          setPreviewText(data.textPreview || "Нет предпросмотра");
        }
      } else {
        setPreviewText(
          "Ошибка генерации отчёта: " + (data.detail || "Неизвестно")
        );
      }
    } catch (e) {
      setPreviewText("Ошибка соединения: " + (e as any)?.message);
    }
    setIsLoading(false);
    nextStep();
  };

  // Вместо handleSave, теперь:
  const handleSave = async () => {
    setIsLoading(true);
    try {
      // Сохраняем расписание
      await handleSaveSchedule();

      // Для теста: запрашиваем предпросмотр/отправку отчёта
      // Здесь можно сделать POST на эндпоинт, который сразу формирует и отправляет отчёт в Телегу
      // Можно добавить флаг "test": true, чтобы не дублировать в истории или не засорять логи

      setStatus({
        ok: true,
        message:
          "Расписание успешно создано! Первый отчёт будет отправлен в Telegram.",
      });
    } catch (e) {
      setStatus({
        ok: false,
        message: "Ошибка при создании расписания: " + (e as any)?.message,
      });
    }
    setIsLoading(false);
    nextStep();
  };

  return (
    <div className={styles.startPage}>
      {/* === МОДАЛЬНОЕ ОКНО ДОБАВЛЕНИЯ КАНАЛА === */}
      {showAddChannelModal && (
        <div className={styles.modalBackdrop}>
          <div className={styles.modal}>
            <h2>Добавить Telegram-канал/топик</h2>
            <form onSubmit={handleAddChannel}>
              <label>ID канала/чата (например, -100...)</label>
              <input
                type="text"
                value={newChannelId}
                onChange={e => setNewChannelId(e.target.value)}
                required
                style={{ width: "100%", marginBottom: 6 }}
              />
              <label>Название (для удобства)</label>
              <input
                type="text"
                value={newChannelName}
                onChange={e => setNewChannelName(e.target.value)}
                style={{ width: "100%", marginBottom: 6 }}
              />
              <label>ID топика (если нужно, иначе оставьте пустым)</label>
              <input
                type="number"
                value={newThreadId}
                onChange={e => setNewThreadId(e.target.value)}
                placeholder="Например: 2"
                style={{ width: "100%", marginBottom: 10 }}
              />
              <div style={{ margin: "12px 0", fontSize: 15 }}>
                <label>
                  <input type="checkbox" checked={sendAsFile} onChange={e => setSendAsFile(e.target.checked)} />
                  <span style={{ marginLeft: 6 }}>Отправлять файлом</span>
                </label>
                <label style={{ marginLeft: 20 }}>
                  <input type="checkbox" checked={sendAsText} onChange={e => setSendAsText(e.target.checked)} />
                  <span style={{ marginLeft: 6 }}>Как текст</span>
                </label>
                <label style={{ marginLeft: 20 }}>
                  <input type="checkbox" checked={sendAsChart} onChange={e => setSendAsChart(e.target.checked)} />
                  <span style={{ marginLeft: 6 }}>График</span>
                </label>
              </div>
              {addChannelError && <div style={{ color: "red", marginBottom: 6 }}>{addChannelError}</div>}
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button type="submit" className={styles.bigBtn} disabled={addingChannel}>
                  {addingChannel ? "Добавление..." : "Добавить"}
                </button>
                <button type="button" className={styles.miniBtn} onClick={() => setShowAddChannelModal(false)}>
                  Отмена
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className={styles.centerWrapper}>
        <div className={styles.card}>
          <BackButton />
          <h1 className={styles.title}>
            Настройка автоматических отчётов в Telegram
          </h1>
          <div className={styles.mainGrid3col}>
            {/* Левая колонка — шаги */}
            <div className={styles.stepsColumn}>
              <div className={styles.stepperWrap}>
                <div className={styles.progressBar}>
                  <div
                    className={styles.progressInner}
                    style={{
                      width: `${((step - 1) / (stepsData.length - 1)) * 100}%`,
                      transition: "width 0.5s cubic-bezier(.5,2,.5,1)",
                    }}
                  />
                </div>
                <ul className={styles.stepsList}>
                  {stepsData.map((stepInfo, idx) => {
                    const isActive = step === idx + 1;
                    const isDone = completed.includes(idx + 1);
                    return (
                      <li
                        key={idx}
                        className={`
                        ${styles.stepItem}
                        ${isActive ? styles.active : ""}
                        ${isDone ? styles.done : ""}
                      `}
                      >
                        {isDone ? (
                          <CheckCircle size={40} className={styles.iconDone} />
                        ) : (
                          <span className={styles.stepNum}>{idx + 1}</span>
                        )}
                        <div>
                          <div className={styles.stepLabel}>
                            {stepInfo.label}
                          </div>
                          <div className={styles.stepDesc}>{stepInfo.desc}</div>
                        </div>
                        {isActive && (
                          <ChevronRight className={styles.chevron} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>

            {/* Средняя колонка — содержимое текущего шага */}
            <div className={styles.formColumn}>
              <form
                className={styles.formArea}
                autoComplete="off"
                onSubmit={(e) => e.preventDefault()}
              >
                {/* Шаг 1: Выбрать/создать шаблон */}
                {step === 1 && (
                  <div>
                    <label className={styles.stepLabel}>
                      Выберите шаблон отчёта
                    </label>
                    <div className={styles.templatesList}>
                      {loadingTemplates && (
                        <div style={{ color: "#379" }}>Загрузка...</div>
                      )}
                      {!loadingTemplates && templates.length === 0 && (
                        <div style={{ color: "#b66" }}>
                          Нет шаблонов. Создайте первый!
                        </div>
                      )}
                      {templates.map((tpl) => (
                        <div
                          key={tpl.id}
                          className={`${styles.templateItem} ${selectedTemplate === tpl.id
                            ? styles.activeTemplate
                            : ""
                            }`}
                          onClick={() => handleSelectTemplate(tpl.id)}
                        >
                          <b>{tpl.name}</b>
                          <div className={styles.templateDesc}>
                            {tpl.description}
                          </div>
                        </div>
                      ))}
                      <button
                        type="button"
                        className={styles.miniBtn}
                        style={{ marginTop: 10 }}
                        onClick={() => navigate("/create-report")}
                      >
                        <Plus size={20} /> Новый шаблон
                      </button>
                    </div>
                    <button
                      className={styles.bigBtn}
                      style={{ marginTop: 28 }}
                      type="button"
                      onClick={nextStep}
                      disabled={!selectedTemplate}
                    >
                      Далее
                    </button>
                  </div>
                )}

                {/* Шаг 2: Выбрать канал */}
                {step === 2 && (
                  <div>
                    <label className={styles.stepLabel}>
                      Выберите Telegram-канал
                    </label>
                    <div className={styles.templatesList}>
                      {channelsLoading ? (
                        <div style={{ color: "#77b5eb", padding: "14px" }}>
                          Загрузка каналов...
                        </div>
                      ) : channels.length === 0 ? (
                        <div style={{ color: "#fa4a4a", padding: "14px" }}>
                          Нет добавленных каналов. <br /> Используйте "+ Добавить канал".
                        </div>
                      ) : (
                        channels.map((ch) => (
                          <div
                            key={ch.id}
                            className={`${styles.templateItem} ${selectedChannel === ch.channel_id
                              ? styles.activeTemplate
                              : ""
                              }`}
                            onClick={() => handleSelectChannel(ch.channel_id)}
                          >
                            <b>{ch.channel_name || ch.channel_id}</b>
                            <div className={styles.templateDesc}>
                              ID: {ch.channel_id}
                              {ch.thread_id ? ` (thread ${ch.thread_id})` : ""}
                            </div>
                          </div>
                        ))
                      )}
                      <button
                        type="button"
                        className={styles.miniBtn}
                        style={{ marginTop: 10 }}
                        onClick={() => setShowAddChannelModal(true)}
                      >
                        <Plus size={20} /> Добавить канал
                      </button>
                    </div>
                    <button
                      className={styles.bigBtn}
                      style={{ marginTop: 28 }}
                      type="button"
                      onClick={nextStep}
                    >
                      Далее
                    </button>
                  </div>
                )}

                {/* Шаг 3: расписание */}
                {step === 3 && (
                  <div>
                    <label className={styles.stepLabel}>
                      Настройте расписание отправки
                    </label>
                    <div className={styles.inputGroup}>
                      <label>Периодичность</label>
                      <select
                        className={styles.input}
                        value={scheduleType}
                        onChange={(e) => setScheduleType(e.target.value)}
                      >
                        <option value="daily">Ежедневно</option>
                        <option value="shift">По сменам (08:00 и 20:00)</option>
                        <option value="hourly">Каждый час</option>
                        <option value="once">Один раз (ручной запуск)</option>
                        <option value="exceed">По превышению нормы</option>
                      </select>
                    </div>

                    {/* Ежедневно */}
                    {scheduleType === "daily" && (
                      <div className={styles.inputGroup}>
                        <label>Время отправки</label>
                        <input
                          type="time"
                          className={styles.input}
                          value={scheduleTime}
                          onChange={(e) => setScheduleTime(e.target.value)}
                          style={{ width: 110 }}
                        />
                      </div>
                    )}

                    {/* По сменам */}
                    {scheduleType === "shift" && (
                      <div className={styles.inputGroup} style={{ gap: 10 }}>
                        <label>
                          Время смен:
                          <span style={{ marginLeft: 10, fontWeight: 500 }}>
                            08:00&nbsp;и&nbsp;20:00
                          </span>
                        </label>
                        <div
                          style={{
                            fontSize: 13,
                            color: "#4fafd9",
                            marginTop: 6,
                          }}
                        >
                          Отчёт будет формироваться в 08:00 и 20:00 по сменам.
                        </div>
                      </div>
                    )}

                    {/* Каждый час */}
                    {scheduleType === "hourly" && (
                      <div className={styles.inputGroup}>
                        <label>Тип данных</label>
                        <select
                          className={styles.input}
                          value={aggregationType}
                          onChange={(e) => setAggregationType(e.target.value)}
                        >
                          <option value="avg">Среднее за час</option>
                          <option value="max">Максимум</option>
                          <option value="min">Минимум</option>
                          <option value="delta">Прирост (для счетчиков)</option>
                          <option value="alerts">Только при отклонениях</option>
                        </select>
                      </div>
                    )}

                    {/* По превышению нормы */}
                    {scheduleType === "exceed" && (
                      <div className={styles.inputGroup}>
                        <span
                          style={{
                            color: "#fd3d3d",
                            fontWeight: 600,
                            fontSize: 15,
                          }}
                        >
                          Отчёт будет отправлен только при выходе значения за норму!
                        </span>
                        <button
                          className={styles.miniBtn}
                          type="button"
                          onClick={goToNormsPage} // заглушка/будущий переход на страницу настройки норм
                          style={{ marginTop: 8 }}
                        >
                          Настроить нормы тегов
                        </button>
                      </div>
                    )}

                    <button
                      className={styles.bigBtn}
                      style={{ marginTop: 22 }}
                      onClick={nextStep}
                      type="button"
                    >
                      Далее
                    </button>
                  </div>
                )}

                {/* Шаг 4: формат */}
                {step === 4 && (
                  <div>
                    <label className={styles.stepLabel}>
                      Выберите формат отправки
                    </label>
                    <div className={styles.templatesList}>
                      {mockFormats.map((fmt) => (
                        <div
                          key={fmt.value}
                          className={`${styles.templateItem} ${selectedFormat === fmt.value
                            ? styles.activeTemplate
                            : ""
                            }`}
                          onClick={() => handleSelectFormat(fmt.value)}
                        >
                          <b>{fmt.label}</b>
                        </div>
                      ))}
                    </div>
                    <button
                      className={styles.bigBtn}
                      style={{ marginTop: 22 }}
                      onClick={nextStep}
                      type="button"
                    >
                      Далее
                    </button>
                  </div>
                )}

                {/* Шаг 5: предпросмотр */}
                {step === 5 && (
                  <div>
                    <label className={styles.stepLabel}>
                      Предпросмотр: как будет выглядеть отправка
                    </label>
                    <div className={styles.previewBlock}>
                      {isLoading ? (
                        <Loader className={styles.loader} />
                      ) : (
                        <div
                          style={{
                            border: "1px solid #ccc",
                            borderRadius: 12,
                            background: "#f8fafc",
                            padding: 16,
                            fontFamily: "monospace",
                            whiteSpace: "pre-wrap",
                            minHeight: 80,
                          }}
                        >
                          {previewText || "Здесь появится пример отчёта..."}
                        </div>
                      )}
                    </div>
                    <button
                      className={styles.bigBtn}
                      onClick={handlePreview}
                      type="button"
                      disabled={isLoading}
                    >
                      <Send
                        size={18}
                        style={{ marginRight: 7, marginBottom: -2 }}
                      />{" "}
                      Показать предпросмотр
                    </button>
                    <button
                      className={styles.bigBtn}
                      style={{ marginLeft: 15 }}
                      onClick={nextStep}
                      type="button"
                    >
                      Далее
                    </button>
                  </div>
                )}

                {/* Шаг 6: финал */}
                {step === 6 && (
                  <div>
                    <div
                      className={styles.stepLabel}
                      style={{ fontSize: 22, marginBottom: 22 }}
                    >
                      Всё готово!
                    </div>
                    <div
                      style={{
                        fontSize: 16,
                        color: status?.ok ? "#4cb64c" : "#e24b4b",
                        marginBottom: 10,
                      }}
                    >
                      {status?.message || "Задача сохранена и включена!"}
                    </div>
                    <button
                      className={styles.bigBtn}
                      onClick={handleSave}
                      type="button"
                      disabled={isLoading}
                    >
                      {isLoading ? (
                        <Loader className={styles.loader} />
                      ) : (
                        "Завершить настройку"
                      )}
                    </button>
                  </div>
                )}
              </form>
            </div>

            {/* Правая колонка — логотип, подсказка */}
            <div className={styles.buttonsColumn}>
              <div className={styles.logoWrap}>
                <img
                  src={logo}
                  alt="Logo"
                  className={styles.logo}
                  style={{ maxWidth: 120, borderRadius: 11, marginBottom: 8 }}
                />
              </div>
              <div className={styles.subtitle} style={{ marginTop: 22 }}>
                <b>Подсказка:</b>
                <div style={{ marginTop: 10, color: "#6497bd" }}>
                  Все параметры и каналы настраиваются через интерфейс,
                  <br />
                  расписания и шаблоны можно менять в любой момент!
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

};

export default TelegramReportWizardPage;
