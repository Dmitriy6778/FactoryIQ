// src/pages/WeighbridgeScadaPage.tsx
import React, {
  useEffect,
  useMemo,
  useState,
  useCallback,
} from "react";
import {
  Card,
  DatePicker,
  Table,
  Statistic,
  Row,
  Col,
  Spin,
  Tabs,
  message,
  Button,
  Input,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { TabsProps } from "antd";
import dayjs, { Dayjs } from "dayjs";
import Plot from "react-plotly.js";

import { useApi } from "../shared/useApi";
import styles from "../styles/WeighbridgeScadaPage.module.css";
import * as XLSX from "xlsx";
import { Download } from "lucide-react"; 
const { RangePicker } = DatePicker;

/* ---------- Типы ---------- */

type SummaryDto = {
  NetKgTotal: number | null;
  TripsCount: number | null;
  MinNetKg: number | null;
  MaxNetKg: number | null;
  AvgNetKg: number | null;
  FirstDate: string | null;
  LastDate: string | null;
};

type ByDayRow = {
  DayDate: string;
  NetKgTotal: number;
  TripsCount: number;
  AvgNetPerTrip: number;
};

type ByWeekRow = {
  YearNum: number;
  IsoWeekNum: number;
  WeekStartDate: string;
  WeekEndDate: string;
  NetKgTotal: number;
  TripsCount: number;
  AvgNetPerTrip: number;
};

type ByMonthRow = {
  YearNum: number;
  MonthNum: number;
  MonthStartDate: string;
  MonthEndDate: string;
  NetKgTotal: number;
  TripsCount: number;
  AvgNetPerTrip: number;
};

type DetailRow = {
  Id: number;
  DateWeight: string;
  CarNumber: string | null;
  Consignor: string | null;
  Consignee: string | null;
  NetKg: number | null;
  PointFrom: string | null;
  PointTo: string | null;
};

/* ---------- Вспомогательные ---------- */

const tons = (kg: number | null | undefined): number =>
  kg != null ? Number((kg / 1000).toFixed(2)) : 0;

const SUNFLOWER_MATERIAL = "подсолнечник";

const WeighbridgeScadaPage: React.FC = () => {
  const api = useApi();

  // по умолчанию — текущий месяц
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>(() => {
    const now = dayjs();
    return [now.startOf("month"), now.endOf("day")];
  });

  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [byDay, setByDay] = useState<ByDayRow[]>([]);
  const [byWeek, setByWeek] = useState<ByWeekRow[]>([]);
  const [byMonth, setByMonth] = useState<ByMonthRow[]>([]);
  const [detail, setDetail] = useState<DetailRow[]>([]);

  // поиск и "ленивая" подгрузка в детальной таблице
  const [searchText, setSearchText] = useState<string>("");
  const [visibleCount, setVisibleCount] = useState<number>(200);

  /* ---------- Период в ISO (для бэка) ---------- */

  const dateFrom = useMemo(
    () => dateRange[0].startOf("day").toISOString(),
    [dateRange]
  );
  const dateTo = useMemo(
    () => dateRange[1].add(1, "day").startOf("day").toISOString(),
    [dateRange]
  );

  const periodTitle =
    dateRange && dateRange[0] && dateRange[1]
      ? `(${dateRange[0].format("DD.MM.YYYY")} — ${dateRange[1].format(
          "DD.MM.YYYY"
        )})`
      : "";

  /* ---------- Загрузка данных (summary + day/week/month + detail) ---------- */
const handleExportExcel = () => {
  if (!detail || !detail.length) {
    message.info("Нет данных для экспорта");
    return;
  }

  const rows = detail.map((r) => ({
    "Дата/время": dayjs(r.DateWeight).format("DD.MM.YYYY HH:mm"),
    Машина: r.CarNumber || "",
    Поставщик: r.Consignor || "",
    Получатель: r.Consignee || "",
    "Нетто, т": r.NetKg != null ? tons(r.NetKg) : "",
    Откуда: r.PointFrom || "",
    Куда: r.PointTo || "",
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);

  XLSX.utils.book_append_sheet(wb, ws, "Рейсы");

  const fromStr = dateRange[0].format("YYYYMMDD");
  const toStr = dateRange[1].format("YYYYMMDD");
  const fileName = `weighbridge_sunflower_${fromStr}_${toStr}.xlsx`;

  XLSX.writeFile(wb, fileName);
};

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        date_from: dateFrom,
        date_to: dateTo,
        material_name: SUNFLOWER_MATERIAL,
      };

     const [summaryRes, byDayRes, byWeekRes, byMonthRes, detailRes] =
  await Promise.all([
    api.get("/weighbridge/sunflower/summary",  params ),
    api.get("/weighbridge/sunflower/by-day",  params ),
    api.get("/weighbridge/sunflower/by-week",  params ),
    api.get("/weighbridge/sunflower/by-month",  params ),
    api.get("/weighbridge/sunflower/detail",  params ),
  ]);


      setSummary((summaryRes as any).summary || null);
      setByDay((byDayRes as any).items || []);
      setByWeek((byWeekRes as any).items || []);
      setByMonth((byMonthRes as any).items || []);
      setDetail((detailRes as any).items || []);
    } catch (e) {
      console.error("loadData error", e);
      message.error("Ошибка загрузки данных автовесов");
      setSummary(null);
      setByDay([]);
      setByWeek([]);
      setByMonth([]);
      setDetail([]);
    } finally {
      setLoading(false);
    }
  }, [api, dateFrom, dateTo]);

  // первая загрузка и при изменении периода
  useEffect(() => {
    loadData();
  }, [loadData]);

  /* ---------- Колонки ---------- */

 

  const detailColumns: ColumnsType<DetailRow & { key: React.Key }> = [
    {
      title: "Дата/время",
      dataIndex: "DateWeight",
      render: (v: string) => dayjs(v).format("DD.MM.YYYY HH:mm"),
      width: 160,
      fixed: "left",
    },
    {
      title: "Машина",
      dataIndex: "CarNumber",
      width: 100,
    },
    {
      title: "Поставщик",
      dataIndex: "Consignor",
      width: 180,
    },
    {
      title: "Получатель",
      dataIndex: "Consignee",
      width: 180,
    },
    {
      title: "Нетто, т",
      dataIndex: "NetKg",
      align: "right",
      render: (v: number | null) => (v != null ? tons(v) : null),
      width: 110,
    },
    {
      title: "Откуда",
      dataIndex: "PointFrom",
      width: 140,
    },
    {
      title: "Куда",
      dataIndex: "PointTo",
      width: 140,
    },
  ];

  const weekColumns: ColumnsType<ByWeekRow & { key: React.Key }> = [
    {
      title: "Год",
      dataIndex: "YearNum",
      width: 70,
    },
    {
      title: "Начало недели",
      dataIndex: "WeekStartDate",
      render: (v: string) => dayjs(v).format("DD.MM.YYYY"),
    },
    {
      title: "Нетто, т",
      dataIndex: "NetKgTotal",
      align: "right",
      render: (v: number) => tons(v),
    },
    {
      title: "Рейсов",
      dataIndex: "TripsCount",
      align: "right",
    },
  ];

  const monthColumns: ColumnsType<ByMonthRow & { key: React.Key }> = [
    {
      title: "Год",
      dataIndex: "YearNum",
      width: 70,
    },
    {
      title: "Месяц",
      dataIndex: "MonthNum",
      width: 80,
      render: (_: any, row: ByMonthRow) =>
        dayjs(
          `${row.YearNum}-${String(row.MonthNum).padStart(2, "0")}-01`
        ).format("MM.YYYY"),
    },
    {
      title: "Нетто, т",
      dataIndex: "NetKgTotal",
      align: "right",
      render: (v: number) => tons(v),
    },
    {
      title: "Рейсов",
      dataIndex: "TripsCount",
      align: "right",
    },
  ];

  /* ---------- Фильтрация недель/месяцев по выбранному периоду ---------- */

  const [fromJs, toJs] = dateRange;
  const fromTs = fromJs.startOf("day").valueOf();
  const toTs = toJs.endOf("day").valueOf();

  const filteredWeeks = useMemo(
    () =>
      byWeek.filter((w) => {
        const ts = dayjs(w.WeekStartDate).valueOf();
        return ts >= fromTs && ts <= toTs;
      }),
    [byWeek, fromTs, toTs]
  );

  const filteredMonths = useMemo(
    () =>
      byMonth.filter((m) => {
        const ts = dayjs(m.MonthStartDate).valueOf();
        return ts >= fromTs && ts <= toTs;
      }),
    [byMonth, fromTs, toTs]
  );

  /* ---------- Данные для графиков ---------- */

  const weekLabels = useMemo(
    () =>
      filteredWeeks.map((w) =>
        dayjs(w.WeekStartDate).format("DD.MM.YYYY")
      ),
    [filteredWeeks]
  );
  const weekNetTons = useMemo(
    () => filteredWeeks.map((w) => tons(w.NetKgTotal)),
    [filteredWeeks]
  );

  const monthLabels = useMemo(
    () =>
      filteredMonths.map((m) =>
        dayjs(
          `${m.YearNum}-${String(m.MonthNum).padStart(2, "0")}-01`
        ).format("MM.YYYY")
      ),
    [filteredMonths]
  );
  const monthNetTons = useMemo(
    () => filteredMonths.map((m) => tons(m.NetKgTotal)),
    [filteredMonths]
  );

  /* ---------- Поиск и "ленивая" таблица детальных рейсов ---------- */

  const filteredDetail = useMemo(() => {
  // 1) всегда сортируем по дате, новые сверху
  const sorted = [...detail].sort(
    (a, b) =>
      dayjs(b.DateWeight).valueOf() - dayjs(a.DateWeight).valueOf()
  );

  const q = searchText.trim().toLowerCase();
  if (!q) return sorted;

  // 2) если введён поиск — фильтруем уже отсортированный массив
  return sorted.filter((r) => {
    const fields = [
      r.CarNumber,
      r.Consignor,
      r.Consignee,
      r.PointFrom,
      r.PointTo,
    ];
    return fields.some((f) =>
      (f || "").toString().toLowerCase().includes(q)
    );
  });
}, [detail, searchText]);


  useEffect(() => {
    setVisibleCount(Math.min(200, filteredDetail.length || 0));
  }, [filteredDetail]);

  const visibleRows = useMemo(
    () => filteredDetail.slice(0, visibleCount),
    [filteredDetail, visibleCount]
  );

  const handleTableScroll: React.UIEventHandler<HTMLDivElement> = (e) => {
    const target = e.currentTarget;
    if (
      target.scrollTop + target.clientHeight >=
      target.scrollHeight - 50
    ) {
      setVisibleCount((prev) =>
        Math.min(prev + 200, filteredDetail.length)
      );
    }
  };

  const daysWithTrips = byDay.length;

  /* ---------- Tabs ---------- */

  const tabItems: TabsProps["items"] = [
    {
      key: "overview",
      label: "Обзор",
      children: (
        <>
        
          {/* Детальная таблица как на странице весовой */}
          <Card
  title="Детальные рейсы (подсолнечник)"
  className={styles.bottomCard}
  size="small"
  extra={
    <Button onClick={handleExportExcel}>
      <Download size={16} style={{ marginRight: 6 }} />
      Экспорт в Excel
    </Button>
  }
>

            <div style={{ marginBottom: 8 }}>
              <span className={styles.filterLabel}>
                Поиск по таблице:&nbsp;
              </span>
              <Input
                allowClear
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Машина, поставщик, получатель, откуда/куда..."
                style={{ maxWidth: 380 }}
              />
            </div>

            <div
              style={{ maxHeight: 420, overflow: "auto" }}
              onScroll={handleTableScroll}
            >
              <Table
                size="small"
                dataSource={visibleRows.map((r) => ({ ...r, key: r.Id }))}
                columns={detailColumns}
                scroll={{ x: 1000, y: 380 }}
                pagination={false}
              />
            </div>
          </Card>

          {/* Сводная статистика по периоду */}
          <Card
            title={
              <>
                Итог по периоду{" "}
                {periodTitle && (
                  <span className={styles.periodTitle}>{periodTitle}</span>
                )}
              </>
            }
            size="small"
            className={styles.summaryCard}
          >
            <Row gutter={8}>
              <Col span={24}>
                <Statistic
                  title="Общий нетто за период, т"
                  value={summary ? tons(summary.NetKgTotal) : 0}
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title="Рейсов за период"
                  value={summary?.TripsCount || 0}
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title="Дней с рейсами"
                  value={daysWithTrips}
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title="Мин. рейс, т"
                  value={
                    summary && summary.MinNetKg
                      ? tons(summary.MinNetKg)
                      : 0
                  }
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title="Макс. рейс, т"
                  value={
                    summary && summary.MaxNetKg
                      ? tons(summary.MaxNetKg)
                      : 0
                  }
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title="Средний вес рейса, т"
                  value={
                    summary && summary.AvgNetKg
                      ? tons(summary.AvgNetKg)
                      : 0
                  }
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title="Период данных"
                  value={
                    summary?.FirstDate && summary?.LastDate
                      ? `${dayjs(summary.FirstDate).format(
                          "DD.MM.YYYY"
                        )} — ${dayjs(summary.LastDate).format(
                          "DD.MM.YYYY"
                        )}`
                      : "—"
                  }
                />
              </Col>
            </Row>
          </Card>
        </>
      ),
    },
    {
      key: "analytics",
      label: "Аналитика",
      children: (
        <div className={styles.analyticsColumn}>
          <Card
            size="small"
            title="По неделям"
            className={styles.analyticsCard}
          >
            <Table
              size="small"
              dataSource={filteredWeeks.map((r, i) => ({
                ...r,
                key: i,
              }))}
              columns={weekColumns}
              pagination={{ pageSize: 20 }}
              scroll={{ x: 600 }}
            />
          </Card>

          <Card
            size="small"
            title="По месяцам"
            className={styles.analyticsCard}
          >
            <Table
              size="small"
              dataSource={filteredMonths.map((r, i) => ({
                ...r,
                key: i,
              }))}
              columns={monthColumns}
              pagination={{ pageSize: 20 }}
              scroll={{ x: 600 }}
            />
          </Card>
        </div>
      ),
    },
    {
      key: "charts",
      label: "Графики",
      children: (
        <div className={styles.chartsWrapper}>
          <Card
            size="small"
            title="Поступление подсолнечника по неделям"
            className={styles.chartCard}
          >
            <Plot
              data={
                [
                  {
                    type: "bar",
                    x: weekLabels,
                    y: weekNetTons,
                    marker: { color: "#FFC107" },
                    text: weekNetTons.map((v) => v.toFixed(1)),
                    textposition: "inside",
                    textfont: {
                      color: "#000000",
                      size: 12,
                    },
                  },
                ] as any
              }
              layout={
                {
                  autosize: true,
                  margin: { l: 40, r: 10, t: 20, b: 60 },
                  xaxis: {
                    title: "Неделя",
                    tickangle: -45,
                    type: "category",
                  },
                  yaxis: { title: "т" },
                } as any
              }
              style={{ width: "100%", height: 320 }}
              useResizeHandler
              config={{ displaylogo: false, responsive: true } as any}
            />
          </Card>

          <Card
            size="small"
            title="Поступление подсолнечника по месяцам"
            className={styles.chartCard}
          >
            <Plot
              data={
                [
                  {
                    type: "bar",
                    x: monthLabels,
                    y: monthNetTons,
                    marker: { color: "#FFC107" },
                    text: monthNetTons.map((v) => v.toFixed(1)),
                    textposition: "inside",
                    textfont: {
                      color: "#000000",
                      size: 12,
                    },
                  },
                ] as any
              }
              layout={
                {
                  autosize: true,
                  margin: { l: 40, r: 10, t: 20, b: 60 },
                  xaxis: {
                    title: "Месяц",
                    tickangle: -45,
                    type: "category",
                  },
                  yaxis: { title: "т" },
                } as any
              }
              style={{ width: "100%", height: 320 }}
              useResizeHandler
              config={{ displaylogo: false, responsive: true } as any}
            />
          </Card>
        </div>
      ),
    },
  ];

  /* ---------- Render ---------- */

  return (
    <div className={styles.page}>
      <Card className={styles.filterCard}>
        
        <Row gutter={16} align="middle">
            
          <Col xs={24} md={10}>
            <span className={styles.filterLabel}>Период:&nbsp;</span>
            <RangePicker
              value={dateRange}
              onChange={(val) => {
                if (!val || val.length !== 2) return;
                setDateRange(val as [Dayjs, Dayjs]);
              }}
              format="DD.MM.YYYY"
              allowClear={false}
            />
          </Col>
        </Row>
      </Card>


      <Spin spinning={loading}>
        <Tabs defaultActiveKey="overview" items={tabItems} />
      </Spin>
    </div>
  );
};

export default WeighbridgeScadaPage;
