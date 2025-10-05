SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[sp_GetAggregatedStats]
    @TagId INT = NULL,
    @GroupId INT = NULL,
    @DateFrom NVARCHAR(50),
    @DateTo NVARCHAR(50),
    @AggType NVARCHAR(10) = 'SUM'  
AS
BEGIN
    SET NOCOUNT ON;
    SET LANGUAGE English;

    DECLARE @DateFromDT DATETIME = CONVERT(datetime, @DateFrom, 120);
    DECLARE @DateToDT   DATETIME = CONVERT(datetime, @DateTo, 120);

    IF @GroupId IS NULL AND @TagId IS NOT NULL
    BEGIN
        DECLARE @sql NVARCHAR(MAX) = N'
            SELECT
                @AggType AS agg_type,
                @TagId   AS tag_id,
                ' + CASE 
                        WHEN @AggType = 'SUM' THEN 'SUM([Value])'
                        WHEN @AggType = 'AVG' THEN 'AVG([Value])'
                        WHEN @AggType = 'MIN' THEN 'MIN([Value])'
                        WHEN @AggType = 'MAX' THEN 'MAX([Value])'
                        ELSE 'NULL' END + N' AS result
            FROM dbo.OpcData
            WHERE TagId = @TagId AND [Timestamp] BETWEEN @DateFromDT AND @DateToDT
        ';
        EXEC sp_executesql @sql,
            N'@TagId INT, @DateFromDT DATETIME, @DateToDT DATETIME, @AggType NVARCHAR(10)',
            @TagId, @DateFromDT, @DateToDT, @AggType;
    END
    ELSE IF @GroupId IS NOT NULL
    BEGIN
 
        DECLARE @sql1 NVARCHAR(MAX) = N'
            SELECT
                @AggType AS agg_type,
                d.TagId  AS tag_id,
                ' + CASE 
                        WHEN @AggType = 'SUM' THEN 'SUM(d.[Value])'
                        WHEN @AggType = 'AVG' THEN 'AVG(d.[Value])'
                        WHEN @AggType = 'MIN' THEN 'MIN(d.[Value])'
                        WHEN @AggType = 'MAX' THEN 'MAX(d.[Value])'
                        ELSE 'NULL' END + N' AS result
            FROM dbo.OpcData d
            INNER JOIN dbo.TagGroups tg ON tg.TagId = d.TagId
            WHERE tg.GroupId = @GroupId AND d.[Timestamp] BETWEEN @DateFromDT AND @DateToDT
            GROUP BY d.TagId
        ';
        EXEC sp_executesql @sql1,
            N'@GroupId INT, @DateFromDT DATETIME, @DateToDT DATETIME, @AggType NVARCHAR(10)',
            @GroupId, @DateFromDT, @DateToDT, @AggType;
    END
END
GO

CREATE OR ALTER PROCEDURE [dbo].[sp_GetBalanceReport]
    @date_from DATE,
    @date_to DATE,
    @tag_ids NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    SET LANGUAGE English;

    DECLARE @TagTable TABLE(TagId INT);
    INSERT INTO @TagTable(TagId)
    SELECT TRY_CAST(value AS INT)
    FROM STRING_SPLIT(@tag_ids, ',');

    ;WITH DateRange AS (
        SELECT @date_from AS [Date]
        UNION ALL
        SELECT DATEADD(DAY, 1, [Date]) FROM DateRange WHERE [Date] < @date_to
    ),
    Shifts AS (
        SELECT 1 AS ShiftNo, N'Дневная' AS ShiftName, CAST('08:00:00' AS time) AS ShiftStart, CAST('19:59:59' AS time) AS ShiftEnd
        UNION ALL
        SELECT 2, N'Ночная', CAST('20:00:00' AS time), CAST('07:59:59' AS time)
    ),
    TagList AS (
        SELECT t.TagId, ot.BrowseName
        FROM @TagTable t
        JOIN dbo.OpcTags ot ON ot.Id = t.TagId
    ),
    ShiftData AS (
        SELECT 
            dr.[Date],
            s.ShiftNo,
            s.ShiftName,
            t.BrowseName AS TagName,
            MIN(od.Value) AS StartValue,
            MAX(od.Value) AS EndValue,
            MAX(od.Value) - MIN(od.Value) AS Delta
        FROM DateRange dr
        CROSS JOIN Shifts s
        CROSS JOIN TagList t
        LEFT JOIN dbo.OpcData od ON
            od.TagId = t.TagId
            AND (
                (s.ShiftNo = 1 AND CAST(od.[Timestamp] AS DATE) = dr.[Date] AND CAST(od.[Timestamp] AS time) BETWEEN s.ShiftStart AND s.ShiftEnd)
                OR
                (s.ShiftNo = 2 AND (
                    (CAST(od.[Timestamp] AS DATE) = dr.[Date] AND CAST(od.[Timestamp] AS time) BETWEEN s.ShiftStart AND CAST('23:59:59' AS time))
                    OR
                    (CAST(od.[Timestamp] AS DATE) = DATEADD(DAY, 1, dr.[Date]) AND CAST(od.[Timestamp] AS time) BETWEEN CAST('00:00:00' AS time) AND s.ShiftEnd)
                ))
            )
        GROUP BY dr.[Date], s.ShiftNo, s.ShiftName, t.TagId, t.BrowseName
    ),
    DailyData AS (
        SELECT 
            sd.[Date],
            NULL AS ShiftNo,
            N'Сутки' AS ShiftName,
            sd.TagName,
            MIN(sd.StartValue) AS StartValue,
            MAX(sd.EndValue) AS EndValue,
            SUM(sd.Delta) AS Delta
        FROM ShiftData sd
        GROUP BY sd.[Date], sd.TagName
    )
    SELECT 
        [Date],
        ShiftNo,
        ShiftName AS [Смена],
        TagName,
        StartValue AS [Начало],
        EndValue AS [Конец],
        Delta AS [Прирост]
    FROM (
        SELECT [Date], ShiftNo, ShiftName, TagName, StartValue, EndValue, Delta FROM ShiftData
        UNION ALL
        SELECT [Date], ShiftNo, ShiftName, TagName, StartValue, EndValue, Delta FROM DailyData
    ) AS Unioned
    ORDER BY 
        [Date], 
        CASE 
            WHEN ShiftName = N'Дневная' THEN 1
            WHEN ShiftName = N'Ночная' THEN 2
            ELSE 3
        END,
        TagName
    OPTION (MAXRECURSION 1000);
END
GO

CREATE OR ALTER PROCEDURE [dbo].[sp_GetCustomReport]
    @DateFrom NVARCHAR(50),
    @DateTo NVARCHAR(50),
    @TagsJson NVARCHAR(MAX) 
AS
BEGIN
    SET NOCOUNT ON;
    SET LANGUAGE English;

    DECLARE @DateFromDT DATETIME = CONVERT(datetime, @DateFrom, 120);
    DECLARE @DateToDT   DATETIME = CONVERT(datetime, @DateTo, 120);

    IF OBJECT_ID('tempdb..#TagConfig') IS NOT NULL DROP TABLE #TagConfig;
    SELECT *
      INTO #TagConfig
      FROM OPENJSON(@TagsJson)
      WITH (
          tag_id INT,
          aggregate NVARCHAR(8),
          interval_minutes INT
      );

    DECLARE @parts TABLE (SqlPart NVARCHAR(MAX));
    DECLARE @TagId INT, @Agg NVARCHAR(8), @Interval INT, @part NVARCHAR(MAX);

    DECLARE TagCursor CURSOR FOR
        SELECT tag_id, aggregate, interval_minutes FROM #TagConfig;

    OPEN TagCursor;
    FETCH NEXT FROM TagCursor INTO @TagId, @Agg, @Interval;

    WHILE @@FETCH_STATUS = 0
    BEGIN
        SET @part = 
        'SELECT ' + 
            CAST(@TagId AS NVARCHAR) + ' AS TagId, ' +
            'ISNULL(''' + ISNULL(@Agg, '') + ''', '''') AS Aggregate, ' +
            CAST(@Interval AS NVARCHAR) + ' AS IntervalMinutes, ' +
            CASE 
                WHEN @Interval > 1 THEN
                    'DATEADD(MINUTE, DATEDIFF(MINUTE, 0, d.[Timestamp]) / ' + CAST(@Interval AS NVARCHAR) + ' * ' + CAST(@Interval AS NVARCHAR) + ', 0)'
                ELSE
                    'd.[Timestamp]'
            END + ' AS TimeGroup, ' +
            CASE
                WHEN ISNULL(@Agg, '') = '' THEN 'MAX(CAST(d.[Value] AS FLOAT))'
                WHEN @Agg = ''      THEN 'MAX(CAST(d.[Value] AS FLOAT))'
                WHEN @Agg = 'AVG'   THEN 'AVG(CAST(d.[Value] AS FLOAT))'
                WHEN @Agg = 'SUM'   THEN 'SUM(CAST(d.[Value] AS FLOAT))'
                WHEN @Agg = 'MIN'   THEN 'MIN(CAST(d.[Value] AS FLOAT))'
                WHEN @Agg = 'MAX'   THEN 'MAX(CAST(d.[Value] AS FLOAT))'
                ELSE 'MAX(CAST(d.[Value] AS FLOAT))'
            END + ' AS Value ' +
        'FROM dbo.OpcData d ' +
        'WHERE d.TagId = ' + CAST(@TagId AS NVARCHAR) + ' AND d.[Timestamp] >= @DateFromDT AND d.[Timestamp] < @DateToDT ' +
        'GROUP BY ' + 
            CASE 
                WHEN @Interval > 1 THEN
                    'DATEADD(MINUTE, DATEDIFF(MINUTE, 0, d.[Timestamp]) / ' + CAST(@Interval AS NVARCHAR) + ' * ' + CAST(@Interval AS NVARCHAR) + ', 0)'
                ELSE
                    'd.[Timestamp]'
            END;

        INSERT INTO @parts(SqlPart) VALUES (@part);

        FETCH NEXT FROM TagCursor INTO @TagId, @Agg, @Interval;
    END

    CLOSE TagCursor;
    DEALLOCATE TagCursor;

    DECLARE @sql NVARCHAR(MAX) = '';
    SELECT @sql = STRING_AGG(SqlPart, ' UNION ALL ')
    FROM @parts;

    IF LEN(@sql) > 0
        EXEC sp_executesql @sql, N'@DateFromDT DATETIME, @DateToDT DATETIME', @DateFromDT, @DateToDT;

    DROP TABLE #TagConfig;
END
GO

CREATE OR ALTER PROCEDURE [dbo].[sp_GetDailyDelta]
    @TagId INT,
    @DateFrom NVARCHAR(50),
    @DateTo NVARCHAR(50)
AS
BEGIN
    SET NOCOUNT ON;
    SET LANGUAGE English;

    DECLARE @DateFromDT DATETIME = CONVERT(datetime, @DateFrom, 120);
    DECLARE @DateToDT   DATETIME = CONVERT(datetime, @DateTo, 120);

    ;WITH Days AS (
        SELECT TOP (DATEDIFF(DAY, @DateFromDT, @DateToDT) + 1)
            DATEADD(DAY, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1, @DateFromDT) AS DayStart
        FROM sys.all_objects
    ),
    DayValues AS (
        SELECT
            d.DayStart,
            o.[Value], o.[Timestamp],
            ROW_NUMBER() OVER (PARTITION BY d.DayStart ORDER BY o.[Timestamp] ASC)  AS rn_asc,
            ROW_NUMBER() OVER (PARTITION BY d.DayStart ORDER BY o.[Timestamp] DESC) AS rn_desc
        FROM Days d
        LEFT JOIN dbo.OpcData o
            ON o.TagId = @TagId
           AND o.[Timestamp] >= d.DayStart
           AND o.[Timestamp] <  DATEADD(DAY, 1, d.DayStart)
    )
    SELECT
        d.DayStart AS [Day],
        v_first.[Value] AS [FirstValue],
        v_last.[Value]  AS [LastValue],
        v_last.[Value] - v_first.[Value] AS [Delta]
    FROM
        (SELECT DISTINCT DayStart FROM DayValues) d
        LEFT JOIN DayValues v_first ON d.DayStart = v_first.DayStart AND v_first.rn_asc = 1
        LEFT JOIN DayValues v_last  ON d.DayStart = v_last.DayStart  AND v_last.rn_desc = 1
    WHERE v_first.[Value] IS NOT NULL AND v_last.[Value] IS NOT NULL
    ORDER BY d.DayStart;
END
GO

CREATE OR ALTER PROCEDURE [dbo].[sp_GetShiftDelta]
    @TagId INT,
    @DateFrom NVARCHAR(50),
    @DateTo   NVARCHAR(50)
AS
BEGIN
    SET NOCOUNT ON;
    SET LANGUAGE English;

    DECLARE @DateFromDT DATETIME = CONVERT(datetime, @DateFrom, 120);
    DECLARE @DateToDT   DATETIME = CONVERT(datetime, @DateTo, 120);

    ;WITH ShiftTimes AS (
        SELECT
            DATEADD(HOUR, 8, d)  AS ShiftStart,  
            DATEADD(HOUR, 20, d) AS ShiftEnd,    
            1 AS ShiftNo
        FROM (
            SELECT TOP (DATEDIFF(DAY, @DateFromDT, @DateToDT) + 1)
                DATEADD(DAY, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1, @DateFromDT) AS d
            FROM sys.all_objects
        ) t
        UNION ALL
        SELECT
            DATEADD(HOUR, 20, d), DATEADD(HOUR, 32, d), 2
        FROM (
            SELECT TOP (DATEDIFF(DAY, @DateFromDT, @DateToDT) + 1)
                DATEADD(DAY, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1, @DateFromDT) AS d
            FROM sys.all_objects
        ) t
    ),
    ShiftValues AS (
        SELECT
            s.ShiftStart, s.ShiftEnd, s.ShiftNo,
            o.[Value], o.[Timestamp],
            ROW_NUMBER() OVER (PARTITION BY s.ShiftStart, s.ShiftNo ORDER BY o.[Timestamp] ASC)  AS rn_asc,
            ROW_NUMBER() OVER (PARTITION BY s.ShiftStart, s.ShiftNo ORDER BY o.[Timestamp] DESC) AS rn_desc
        FROM ShiftTimes s
        LEFT JOIN dbo.OpcData o
            ON o.TagId = @TagId
           AND o.[Timestamp] >= s.ShiftStart
           AND o.[Timestamp] <  s.ShiftEnd
    )
    SELECT
        s.ShiftStart,
        s.ShiftNo,
        v_first.[Value] AS FirstValue,
        v_last.[Value]  AS LastValue,
        v_last.[Value] - v_first.[Value] AS ShiftDelta
    FROM
        (SELECT DISTINCT ShiftStart, ShiftNo FROM ShiftValues) s
        LEFT JOIN ShiftValues v_first ON s.ShiftStart = v_first.ShiftStart AND s.ShiftNo = v_first.ShiftNo AND v_first.rn_asc = 1
        LEFT JOIN ShiftValues v_last  ON s.ShiftStart = v_last.ShiftStart  AND s.ShiftNo = v_last.ShiftNo  AND v_last.rn_desc = 1
    WHERE v_first.[Value] IS NOT NULL AND v_last.[Value] IS NOT NULL
    ORDER BY s.ShiftStart, s.ShiftNo;
END
GO

CREATE OR ALTER PROCEDURE [dbo].[sp_GetTagTrend]
    @TagId INT,
    @DateFrom NVARCHAR(50),
    @DateTo NVARCHAR(50)
AS
BEGIN
    SET NOCOUNT ON;
    SET LANGUAGE English;

    DECLARE @DateFromDT DATETIME = CONVERT(datetime, @DateFrom, 120);
    DECLARE @DateToDT   DATETIME = CONVERT(datetime, @DateTo, 120);

    SELECT [Timestamp], [Value]
    FROM dbo.OpcData
    WHERE TagId = @TagId
      AND [Timestamp] BETWEEN @DateFromDT AND @DateToDT
    ORDER BY [Timestamp];
END
GO


CREATE OR ALTER PROCEDURE [dbo].[sp_Telegram_BalanceReport_Compare]
    @period_type NVARCHAR(10),     
    @date_to DATE,
    @tag_ids NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @TagTable TABLE(TagId INT);
    INSERT INTO @TagTable(TagId)
    SELECT TRY_CAST(value AS INT)
    FROM STRING_SPLIT(@tag_ids, ',');

    DECLARE @curr_start DATE, @curr_end DATE, @prev_start DATE, @prev_end DATE;

    IF @period_type = 'daily'
    BEGIN
        SET @curr_end   = @date_to;
        SET @curr_start = DATEADD(DAY, -1, @curr_end);
        SET @prev_end   = @curr_start;
        SET @prev_start = DATEADD(DAY, -1, @prev_end);
    END
    ELSE IF @period_type = 'weekly'
    BEGIN
        SET @curr_end   = @date_to;
        SET @curr_start = DATEADD(DAY, -6, @curr_end);
        SET @prev_end   = DATEADD(DAY, -7, @curr_end);
        SET @prev_start = DATEADD(DAY, -6, @prev_end);
    END
    ELSE IF @period_type = 'monthly'
    BEGIN
        SET @curr_end   = @date_to;
        SET @curr_start = DATEADD(MONTH, -1, @curr_end);
        SET @prev_end   = @curr_start;
        SET @prev_start = DATEADD(MONTH, -1, @prev_end);
    END

    ;WITH TagList AS (
        SELECT t.TagId, ot.BrowseName
        FROM @TagTable t
        JOIN dbo.OpcTags ot ON ot.Id = t.TagId
    ),
    CurrData AS (
        SELECT
            t.BrowseName AS TagName,
            MIN(od.Value) AS StartValue,
            MAX(od.Value) AS EndValue,
            MAX(od.Value) - MIN(od.Value) AS Delta
        FROM TagList t
        LEFT JOIN dbo.OpcData od ON od.TagId = t.TagId
            AND od.[Timestamp] >= @curr_start AND od.[Timestamp] < DATEADD(DAY, 1, @curr_end)
        GROUP BY t.BrowseName
    ),
    PrevData AS (
        SELECT
            t.BrowseName AS TagName,
            MIN(od.Value) AS StartValue,
            MAX(od.Value) AS EndValue,
            MAX(od.Value) - MIN(od.Value) AS Delta
        FROM TagList t
        LEFT JOIN dbo.OpcData od ON od.TagId = t.TagId
            AND od.[Timestamp] >= @prev_start AND od.[Timestamp] < DATEADD(DAY, 1, @prev_end)
        GROUP BY t.BrowseName
    )
    SELECT
        c.TagName,
        c.Delta AS CurrDelta,
        p.Delta AS PrevDelta,
        CASE 
            WHEN ISNULL(p.Delta,0) = 0 AND ISNULL(c.Delta,0) = 0 THEN 0
            WHEN ISNULL(p.Delta,0) = 0 THEN 100
            ELSE ROUND((ISNULL(c.Delta,0) - ISNULL(p.Delta,0)) * 100.0 / NULLIF(p.Delta,0), 1)
        END AS PercentChange
    FROM CurrData c
    LEFT JOIN PrevData p ON c.TagName = p.TagName
    ORDER BY c.TagName;
END
GO

CREATE OR ALTER PROCEDURE [dbo].[sp_Telegram_BalanceReport_Daily]
    @date_from DATE,
    @date_to DATE,
    @tag_ids NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    SET LANGUAGE English;

    DECLARE @TagTable TABLE(TagId INT);
    INSERT INTO @TagTable(TagId)
    SELECT TRY_CAST(value AS INT)
    FROM STRING_SPLIT(@tag_ids, ',');

    ;WITH DateRange AS (
        SELECT @date_from AS [Date]
        UNION ALL
        SELECT DATEADD(DAY, 1, [Date]) FROM DateRange WHERE [Date] < @date_to
    ),
    TagList AS (
        SELECT t.TagId, ot.BrowseName
        FROM @TagTable t
        JOIN dbo.OpcTags ot ON ot.Id = t.TagId
    ),
    DailyData AS (
        SELECT 
            dr.[Date],
            t.BrowseName AS TagName,
            MIN(od.Value) AS StartValue,
            MAX(od.Value) AS EndValue,
            MAX(od.Value) - MIN(od.Value) AS Delta
        FROM DateRange dr
        CROSS JOIN TagList t
        LEFT JOIN dbo.OpcData od ON
            od.TagId = t.TagId
            AND CAST(od.[Timestamp] AS DATE) = dr.[Date]
        GROUP BY dr.[Date], t.TagId, t.BrowseName
    )
    SELECT 
        [Date],
        N'Сутки' AS [Смена],
        TagName,
        StartValue AS [Начало],
        EndValue AS [Конец],
        Delta AS [Прирост]
    FROM DailyData
    ORDER BY [Date], TagName
    OPTION (MAXRECURSION 1000);
END
GO

CREATE OR ALTER PROCEDURE [dbo].[sp_Telegram_BalanceReport_Monthly]
    @date_from DATE,
    @date_to DATE,
    @tag_ids NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    SET LANGUAGE English;

    DECLARE @TagTable TABLE(TagId INT);
    INSERT INTO @TagTable(TagId)
    SELECT TRY_CAST(value AS INT)
    FROM STRING_SPLIT(@tag_ids, ',');

    SELECT 
        FORMAT(@date_from, 'yyyy-MM') AS [Период],
        ot.BrowseName AS [TagName],
        MIN(od.Value) AS [Начало],
        MAX(od.Value) AS [Конец],
        MAX(od.Value) - MIN(od.Value) AS [Прирост]
    FROM @TagTable t
    JOIN dbo.OpcTags ot ON ot.Id = t.TagId
    LEFT JOIN dbo.OpcData od ON od.TagId = t.TagId AND CAST(od.[Timestamp] AS DATE) BETWEEN @date_from AND @date_to
    GROUP BY ot.BrowseName
    ORDER BY ot.BrowseName;
END
GO

CREATE OR ALTER PROCEDURE [dbo].[sp_Telegram_BalanceReport_Shift]
    @date_from DATE,
    @date_to DATE,
    @tag_ids NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    SET LANGUAGE English;

    DECLARE @TagTable TABLE(TagId INT);
    INSERT INTO @TagTable(TagId)
    SELECT TRY_CAST(value AS INT)
    FROM STRING_SPLIT(@tag_ids, ',');

    ;WITH DateRange AS (
        SELECT @date_from AS [Date]
        UNION ALL
        SELECT DATEADD(DAY, 1, [Date]) FROM DateRange WHERE [Date] < @date_to
    ),
    Shifts AS (
        SELECT 1 AS ShiftNo, N'Дневная' AS ShiftName, CAST('08:00:00' AS time) AS ShiftStart, CAST('19:59:59' AS time) AS ShiftEnd
        UNION ALL
        SELECT 2, N'Ночная', CAST('20:00:00' AS time), CAST('07:59:59' AS time)
    ),
    TagList AS (
        SELECT t.TagId, ot.BrowseName
        FROM @TagTable t
        JOIN dbo.OpcTags ot ON ot.Id = t.TagId
    ),
    ShiftData AS (
        SELECT 
            dr.[Date],
            s.ShiftNo,
            s.ShiftName,
            t.BrowseName AS TagName,
            MIN(od.Value) AS StartValue,
            MAX(od.Value) AS EndValue,
            MAX(od.Value) - MIN(od.Value) AS Delta
        FROM DateRange dr
        CROSS JOIN Shifts s
        CROSS JOIN TagList t
        LEFT JOIN dbo.OpcData od ON
            od.TagId = t.TagId
            AND (
                (s.ShiftNo = 1 AND CAST(od.[Timestamp] AS DATE) = dr.[Date] AND CAST(od.[Timestamp] AS time) BETWEEN s.ShiftStart AND s.ShiftEnd)
                OR
                (s.ShiftNo = 2 AND (
                    (CAST(od.[Timestamp] AS DATE) = dr.[Date] AND CAST(od.[Timestamp] AS time) BETWEEN s.ShiftStart AND CAST('23:59:59' AS time))
                    OR
                    (CAST(od.[Timestamp] AS DATE) = DATEADD(DAY, 1, dr.[Date]) AND CAST(od.[Timestamp] AS time) BETWEEN CAST('00:00:00' AS time) AND s.ShiftEnd)
                ))
            )
        GROUP BY dr.[Date], s.ShiftNo, s.ShiftName, t.TagId, t.BrowseName
    )
    SELECT 
        [Date],
        ShiftNo,
        ShiftName AS [Смена],
        TagName,
        StartValue AS [Начало],
        EndValue AS [Конец],
        Delta AS [Прирост]
    FROM ShiftData
    WHERE ShiftName IN (N'Дневная', N'Ночная')
    ORDER BY [Date], ShiftNo, TagName
    OPTION (MAXRECURSION 1000);
END
GO

CREATE OR ALTER PROCEDURE [dbo].[sp_Telegram_BalanceReport_Weekly]
    @date_from DATE,
    @date_to DATE,
    @tag_ids NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    SET LANGUAGE English;

    DECLARE @TagTable TABLE(TagId INT);
    INSERT INTO @TagTable(TagId)
    SELECT TRY_CAST(value AS INT)
    FROM STRING_SPLIT(@tag_ids, ',');

    SELECT 
        CAST(@date_from AS VARCHAR(10)) + N' — ' + CAST(@date_to AS VARCHAR(10)) AS [Период],
        ot.BrowseName AS [TagName],
        MIN(od.Value) AS [Начало],
        MAX(od.Value) AS [Конец],
        MAX(od.Value) - MIN(od.Value) AS [Прирост]
    FROM @TagTable t
    JOIN dbo.OpcTags ot ON ot.Id = t.TagId
    LEFT JOIN dbo.OpcData od ON od.TagId = t.TagId AND CAST(od.[Timestamp] AS DATE) BETWEEN @date_from AND @date_to
    GROUP BY ot.BrowseName
    ORDER BY ot.BrowseName;
END
GO


CREATE OR ALTER PROCEDURE [dbo].[sp_Telegram_TagValues_MultiAgg]
    @DateFrom NVARCHAR(50),
    @DateTo   NVARCHAR(50),
    @TagsJson NVARCHAR(MAX),
    @GroupType NVARCHAR(10) = 'hour'  -- hour/day/none
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @DateFromDT DATETIME = CONVERT(datetime, @DateFrom, 120);
    DECLARE @DateToDT   DATETIME = CONVERT(datetime, @DateTo, 120);

    IF OBJECT_ID('tempdb..#TagAggs') IS NOT NULL DROP TABLE #TagAggs;
    SELECT tag_id, aggregate, interval_minutes
    INTO #TagAggs
    FROM OPENJSON(@TagsJson)
         WITH (
            tag_id INT,
            aggregates NVARCHAR(MAX) AS JSON,
            interval_minutes INT
         )
         CROSS APPLY OPENJSON(aggregates) WITH (aggregate NVARCHAR(10) '$') AS Aggs;

    DECLARE @parts TABLE (SqlPart NVARCHAR(MAX));
    DECLARE @TagId INT, @Agg NVARCHAR(10), @Interval INT, @part NVARCHAR(MAX);

    DECLARE TagCursor CURSOR FOR
        SELECT tag_id, aggregate, interval_minutes FROM #TagAggs;

    OPEN TagCursor;
    FETCH NEXT FROM TagCursor INTO @TagId, @Agg, @Interval;

    WHILE @@FETCH_STATUS = 0
    BEGIN
        DECLARE @timeExpr  NVARCHAR(200) =
            CASE
                WHEN @GroupType = N'hour' THEN N'DATEADD(HOUR, DATEDIFF(HOUR, 0, d.[Timestamp]), 0)'
                WHEN @GroupType = N'day'  THEN N'CAST(d.[Timestamp] AS DATE)'
                ELSE                           N'd.[Timestamp]'
            END;

        DECLARE @groupExpr NVARCHAR(400) =
            CASE
                WHEN @GroupType = N'hour' THEN N'DATEADD(HOUR, DATEDIFF(HOUR, 0, d.[Timestamp]), 0), d.TagId, t.BrowseName'
                WHEN @GroupType = N'day'  THEN N'CAST(d.[Timestamp] AS DATE), d.TagId, t.BrowseName'
                ELSE                           N'd.[Timestamp], d.TagId, t.BrowseName'
            END;

        DECLARE @aggExpr NVARCHAR(100) =
            CASE
                WHEN @Agg = N'AVG'  THEN N'AVG(CAST(d.[Value] AS FLOAT))'
                WHEN @Agg = N'MIN'  THEN N'MIN(CAST(d.[Value] AS FLOAT))'
                WHEN @Agg = N'MAX'  THEN N'MAX(CAST(d.[Value] AS FLOAT))'
                WHEN @Agg = N'CURR' THEN N'MAX(CAST(d.[Value] AS FLOAT))'  
                ELSE                       N'AVG(CAST(d.[Value] AS FLOAT))'
            END;

        SET @part =
            N'SELECT ' + @timeExpr + N' AS [Period], ' +
            N'd.TagId, t.BrowseName AS TagName, ' +
            N'''' + ISNULL(@Agg, N'') + N''' AS Aggregate, ' +
            @aggExpr + N' AS Value ' +
            N'FROM dbo.OpcData d ' +
            N'JOIN dbo.OpcTags t ON t.Id = d.TagId ' +
            N'WHERE d.TagId = ' + CAST(@TagId AS NVARCHAR(20)) +
            N' AND d.[Timestamp] >= @DateFromDT AND d.[Timestamp] < @DateToDT ' +
            N'GROUP BY ' + @groupExpr;

        INSERT INTO @parts(SqlPart) VALUES (@part);

        FETCH NEXT FROM TagCursor INTO @TagId, @Agg, @Interval;
    END

    CLOSE TagCursor;
    DEALLOCATE TagCursor;

    DECLARE @sql NVARCHAR(MAX) = N'';
    SELECT @sql = STRING_AGG(SqlPart, N' UNION ALL ')
    FROM @parts;

    IF LEN(@sql) > 0
        EXEC sp_executesql @sql, N'@DateFromDT DATETIME, @DateToDT DATETIME', @DateFromDT, @DateToDT;

    DROP TABLE #TagAggs;
END
GO

