// src/pages/WeighbridgePage.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  Card,
  DatePicker,
  Select,
  Table,
  Statistic,
  Row,
  Col,
  Spin,
  message,
  Button,
  Input,
  Checkbox,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { Dayjs } from "dayjs";
import * as XLSX from "xlsx";
import { Download } from "lucide-react";

import { useApi } from "../shared/useApi";
import styles from "../styles/WeighbridgePage.module.css";
import BackButton from "../components/BackButton";
const { RangePicker } = DatePicker;

/* ---------- Типы ---------- */

type MaterialItem = {
  MaterialName: string;
};

type DirectionItem = {
  value: string; // all | in | out
  label: string;
};

type SummaryRow = {
  NetKgTotal: number | null;
  TripsCount: number;
  MinNetKg: number | null;
  MaxNetKg: number | null;
  AvgNetKg: number | null;
  FirstDate: string | null;
  LastDate: string | null;
};

type SummaryResponse = {
  period: SummaryRow | null;
  overall: SummaryRow | null;
};

type ByDayRow = {
  DayDate: string;
  NetKgTotal: number;
  TripsCount: number;
};

type DetailRow = {
  Id: number;
  DateWeight: string;
  CarNumber: string | null;
  CarMark: string | null;
  MaterialName: string | null;
  OperationType: string | null;
  PointFrom: string | null;
  PointTo: string | null;
  Consignor: string | null;
  Consignee: string | null;
  NetKg: number | null;
};

/* ---------- Компонент ---------- */

const WeighbridgePage: React.FC = () => {
  const api = useApi();

  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [directions, setDirections] = useState<DirectionItem[]>([]);

  const [material, setMaterial] = useState<string | undefined>(undefined);
  const [showAllMaterials, setShowAllMaterials] = useState<boolean>(true);
  const [direction, setDirection] = useState<string>("all");

  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>([
    dayjs().startOf("year"),
    dayjs().endOf("day"),
  ]);

  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [byDay, setByDay] = useState<ByDayRow[]>([]);
  const [detail, setDetail] = useState<DetailRow[]>([]);
  const [searchText, setSearchText] = useState<string>("");

  // для "ленивой" отрисовки
  const [visibleCount, setVisibleCount] = useState<number>(200);

  /* ---------- Helpers ---------- */

  const dateFrom = useMemo(
    () => (dateRange ? dateRange[0].startOf("day").toISOString() : undefined),
    [dateRange]
  );

  const dateTo = useMemo(
    () =>
      dateRange
        ? dateRange[1].add(1, "day").startOf("day").toISOString()
        : undefined,
    [dateRange]
  );

  const tons = (kg: number | null | undefined): number =>
    kg != null ? Number((kg / 1000).toFixed(3)) : 0;

  const daysWithTrips = byDay.length;

  const periodTitle =
    dateRange && dateRange[0] && dateRange[1]
      ? `(${dateRange[0].format("DD.MM.YYYY")} — ${dateRange[1].format(
          "DD.MM.YYYY"
        )})`
      : "";

  /* ---------- Загрузка справочников ---------- */

  useEffect(() => {
    const loadCommon = async () => {
      try {
        const [matRes, dirRes] = await Promise.all([
          api.get("/weighbridge/v2/materials"),
          api.get("/weighbridge/v2/directions"),
        ]);

        setMaterials(matRes.items || []);
        const dirItems: DirectionItem[] = (dirRes.items || []) as any;
        setDirections(dirItems);

        // если не "все материалы" и материал не выбран — подставим первый
        if (
          !showAllMaterials &&
          !material &&
          matRes.items &&
          matRes.items.length > 0
        ) {
          setMaterial(matRes.items[0].MaterialName);
        }
      } catch (e) {
        console.error(e);
        message.error("Не удалось загрузить справочники весовой");
      }
    };
    loadCommon();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  /* ---------- Загрузка данных по фильтрам ---------- */

  const loadData = async () => {
    if (!dateRange) {
      message.warning("Укажите период");
      return;
    }

    setLoading(true);
    try {
      const params: any = {
        date_from: dateFrom,
        date_to: dateTo,
        direction,
      };

      if (!showAllMaterials && material) {
        params.material_name = material;
      }

      // ВАЖНО: передаём params напрямую, а не { params }
      const [summaryRes, byDayRes, detailRes] = await Promise.all([
        api.get("/weighbridge/v2/summary", params),
        api.get("/weighbridge/v2/by-day", params),
        api.get("/weighbridge/v2/detail", params),
      ]);

      setSummary(summaryRes as SummaryResponse);
      setByDay((byDayRes as any).items || []);
      setDetail((detailRes as any).items || []);
    } catch (e) {
      console.error(e);
      message.error("Ошибка загрузки данных автовесов");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!dateFrom || !dateTo) return;
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [material, showAllMaterials, direction, dateFrom, dateTo]);

  /* ---------- Клиентский поиск по таблице ---------- */

  const filteredDetail = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) return detail;

    return detail.filter((r) => {
      const fields = [
        r.CarNumber,
        r.CarMark,
        r.MaterialName,
        r.OperationType,
        r.PointFrom,
        r.PointTo,
        r.Consignor,
        r.Consignee,
      ];
      return fields.some((f) =>
        (f || "").toString().toLowerCase().includes(q)
      );
    });
  }, [detail, searchText]);

  // сбрасываем "ленивый" лимит при смене данных / фильтра
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

  /* ---------- Экспорт в Excel (все строки) ---------- */

  const handleExportExcel = () => {
    if (!detail.length) {
      message.info("Нет данных для экспорта");
      return;
    }

    const rowsForExcel = detail.map((r) => ({
      "Дата/время": dayjs(r.DateWeight).format("DD.MM.YYYY HH:mm"),
      Машина: r.CarNumber || "",
      Марка: r.CarMark || "",
      Материал: r.MaterialName || "",
      Операция: r.OperationType || "",
      Откуда: r.PointFrom || "",
      Куда: r.PointTo || "",
      Поставщик: r.Consignor || "",
      Получатель: r.Consignee || "",
      "Нетто, т": r.NetKg != null ? tons(r.NetKg) : null,
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rowsForExcel);
    XLSX.utils.book_append_sheet(wb, ws, "Рейсы");

    const matSafe = (material || "all").replace(/[\\/:*?"<>|]/g, "_");
    const fromStr = dateRange ? dateRange[0].format("YYYYMMDD") : "";
    const toStr = dateRange ? dateRange[1].format("YYYYMMDD") : "";
    const fileName = `weighbridge_${matSafe}_${direction}_${fromStr}_${toStr}.xlsx`;

    XLSX.writeFile(wb, fileName);
  };

  /* ---------- Колонки таблицы ---------- */

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
      width: 110,
    },
    {
      title: "Марка",
      dataIndex: "CarMark",
      width: 120,
    },
    {
      title: "Материал",
      dataIndex: "MaterialName",
      width: 150,
    },
    {
      title: "Операция",
      dataIndex: "OperationType",
      width: 130,
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
  ];

  const periodSummary = summary?.period || null;
  const overallSummary = summary?.overall || null;

  /* ---------- Render ---------- */

  return (
    <div className={styles.page}>
         <BackButton />
      {/* Фильтры */}
      <Card className={styles.filterCard}>
        <Row gutter={16} align="middle">
          <Col xs={24} md={8}>
            <span className={styles.filterLabel}>Период:&nbsp;</span>
            <RangePicker
              value={dateRange}
              onChange={(val) => setDateRange(val as [Dayjs, Dayjs] | null)}
              format="DD.MM.YYYY"
              allowClear={false}
            />
          </Col>

          <Col xs={24} md={8}>
            <span className={styles.filterLabel}>Материал:&nbsp;</span>
            <Checkbox
              checked={showAllMaterials}
              onChange={(e) => setShowAllMaterials(e.target.checked)}
              style={{ marginRight: 8 }}
            >
              Показать все
            </Checkbox>
            <Select
              style={{ minWidth: 200 }}
              value={showAllMaterials ? undefined : material}
              onChange={(val) => {
                setMaterial(val);
                setShowAllMaterials(false);
              }}
              showSearch
              optionFilterProp="children"
              placeholder="Выберите материал"
              disabled={showAllMaterials}
              allowClear
            >
              {materials.map((m) => (
                <Select.Option key={m.MaterialName} value={m.MaterialName}>
                  {m.MaterialName}
                </Select.Option>
              ))}
            </Select>
          </Col>

          <Col xs={24} md={8}>
            <span className={styles.filterLabel}>Ввоз / вывоз:&nbsp;</span>
            <Select
              style={{ minWidth: 220 }}
              value={direction}
              onChange={(val) => setDirection(val)}
            >
              {directions.map((d) => (
                <Select.Option key={d.value} value={d.value}>
                  {d.label}
                </Select.Option>
              ))}
            </Select>
          </Col>
        </Row>
      </Card>

      <Spin spinning={loading}>
        {/* 1. Сначала детальная таблица */}
        <Card
          title="Детальные рейсы"
          className={styles.bottomCard}
          size="small"
          extra={
            <Button onClick={handleExportExcel}>
              <Download size={16} style={{ marginRight: 6 }} />
              Экспорт в Excel
            </Button>
          }
        >
          <div className={styles.searchRow}>
            <span className={styles.filterLabel}>Поиск по таблице:&nbsp;</span>
            <Input
              allowClear
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Машина, материал, поставщик, получатель, откуда/куда..."
              style={{ maxWidth: 380 }}
            />
          </div>

          <div
            className={styles.tableScrollWrapper}
            onScroll={handleTableScroll}
          >
            <Table
              size="small"
              dataSource={visibleRows.map((r) => ({ ...r, key: r.Id }))}
              columns={detailColumns}
              scroll={{ x: 1100, y: 420 }}
              pagination={false} // без пагинации
            />
          </div>
        </Card>

        {/* 2. Блок статистики под таблицей */}
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
                value={periodSummary ? tons(periodSummary.NetKgTotal) : 0}
              />
            </Col>
            <Col span={12}>
              <Statistic
                title="Рейсов за период"
                value={periodSummary?.TripsCount || 0}
              />
            </Col>
            <Col span={12}>
              <Statistic title="Дней с рейсами" value={daysWithTrips} />
            </Col>
            <Col span={12}>
              <Statistic
                title="Мин. рейс, т"
                value={
                  periodSummary && periodSummary.MinNetKg
                    ? tons(periodSummary.MinNetKg)
                    : 0
                }
              />
            </Col>
            <Col span={12}>
              <Statistic
                title="Макс. рейс, т"
                value=
                  {periodSummary && periodSummary.MaxNetKg
                    ? tons(periodSummary.MaxNetKg)
                    : 0}
              />
            </Col>
            <Col span={24}>
              <Statistic
                title="Всего за весь период данных, т"
                value={
                  overallSummary && overallSummary.NetKgTotal
                    ? tons(overallSummary.NetKgTotal)
                    : 0
                }
              />
            </Col>
          </Row>
        </Card>
      </Spin>
    </div>
  );
};

export default WeighbridgePage;
