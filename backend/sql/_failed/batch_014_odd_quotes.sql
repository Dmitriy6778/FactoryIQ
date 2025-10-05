/* =========================================================
   sp_Telegram_TagValues_MultiAgg
   ========================================================= */
CREATE OR ALTER PROCEDURE [dbo].[sp_Telegram_TagValues_MultiAgg]
    @DateFrom NVARCHAR(50),
    @DateTo NVARCHAR(50),
    @TagsJson NVARCHAR(MAX), -- [{"tag_id":1,"aggregates":["AVG","MIN","MAX","CURR"],"interval_minutes":60}]
    @GroupType NVARCHAR(10) = 'hour'  -- hour/day/shift/none
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
        SET @part = 
        'SELECT ' +
            CASE 
                WHEN @GroupType = ''hour'' THEN ' + N'DATEADD(HOUR, DATEDIFF(HOUR, 0, d.[Timestamp]), 0)'
                WHEN @GroupType = ''day''  THEN ' + N'CAST(d.[Timestamp] AS DATE)'
                ELSE                             ' + N'd.[Timestamp]'
            END + N' AS [Period], ' +
            N'd.TagId, t.BrowseName AS TagName, ' +
            N'''' + @Agg + N''' AS Aggregate, ' +
            CASE
                WHEN @Agg = 'AVG'  THEN N'AVG(CAST(d.[Value] AS FLOAT))'
                WHEN @Agg = 'MIN'  THEN N'MIN(CAST(d.[Value] AS FLOAT))'
                WHEN @Agg = 'MAX'  THEN N'MAX(CAST(d.[Value] AS FLOAT))'
                WHEN @Agg = 'CURR' THEN N'MAX(CAST(d.[Value] AS FLOAT))'  -- безопасная замена "последним" значением в группе
                ELSE                      N'AVG(CAST(d.[Value] AS FLOAT))'
            END + N' AS Value ' +
            N'FROM dbo.OpcData d ' +
            N'JOIN dbo.OpcTags t ON t.Id = d.TagId ' +
            N'WHERE d.TagId = ' + CAST(@TagId AS NVARCHAR) + N' AND d.[Timestamp] >= @DateFromDT AND d.[Timestamp] < @DateToDT ' +
            N'GROUP BY ' +
                CASE 
                    WHEN @GroupType = 'hour' THEN N'DATEADD(HOUR, DATEDIFF(HOUR, 0, d.[Timestamp]), 0), d.TagId, t.BrowseName'
                    WHEN @GroupType = 'day'  THEN N'CAST(d.[Timestamp] AS DATE), d.TagId, t.BrowseName'
                    ELSE                           N'd.[Timestamp], d.TagId, t.BrowseName'
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

    DROP TABLE #TagAggs;
END