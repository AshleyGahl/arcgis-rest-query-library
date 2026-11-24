-- ============================================================================
-- 02  GeoJSON -> ServiceRequests via OPENJSON
--     View form:        dbo.vw_ServiceRequests_GeoJson  (parses the latest stored document)
--     Stored-proc form: dbo.usp_ImportServiceRequestsGeoJson (stores + loads the table)
-- Dates arrive as epoch milliseconds (UTC), Esri-style; converted to SAST (UTC+2).
-- ============================================================================

-- ---------------------------------------------------------------- VIEW FORM
CREATE OR ALTER VIEW dbo.vw_ServiceRequests_GeoJson
AS
WITH LatestDoc AS
(
    SELECT TOP (1) d.Body
    FROM dbo.GeoJsonDocument AS d
    WHERE d.LayerName = N'ServiceRequests'
    ORDER BY d.DocumentId DESC
)
SELECT
    f.ObjectID,
    f.RequestID,
    f.Category,
    f.RequestType,
    f.Status,
    f.Channel,
    f.Suburb,
    f.Description,
    DateLogged    = CASE WHEN f.DateLoggedMs    IS NULL THEN NULL
                         ELSE DATEADD(HOUR, 2, DATEADD(SECOND, CAST(f.DateLoggedMs    / 1000 AS INT), CAST('1970-01-01' AS DATETIME2(0)))) END,
    DateCompleted = CASE WHEN f.DateCompletedMs IS NULL THEN NULL
                         ELSE DATEADD(HOUR, 2, DATEADD(SECOND, CAST(f.DateCompletedMs / 1000 AS INT), CAST('1970-01-01' AS DATETIME2(0)))) END,
    f.Longitude,
    f.Latitude
FROM LatestDoc AS ld
CROSS APPLY OPENJSON(ld.Body, N'$.features')
WITH
(
    ObjectID         INT            N'$.properties.ObjectID',
    RequestID        NVARCHAR(20)   N'$.properties.RequestID',
    Category         NVARCHAR(50)   N'$.properties.Category',
    RequestType      NVARCHAR(60)   N'$.properties.RequestType',
    Status           NVARCHAR(20)   N'$.properties.Status',
    Channel          NVARCHAR(20)   N'$.properties.Channel',
    Suburb           NVARCHAR(60)   N'$.properties.Suburb',
    Description      NVARCHAR(600)  N'$.properties.Description',
    DateLoggedMs     BIGINT         N'$.properties.DateLogged',
    DateCompletedMs  BIGINT         N'$.properties.DateCompleted',
    Longitude        FLOAT          N'$.geometry.coordinates[0]',
    Latitude         FLOAT          N'$.geometry.coordinates[1]'
) AS f;
GO

-- ---------------------------------------------------------------- STORED-PROC FORM
CREATE OR ALTER PROCEDURE dbo.usp_ImportServiceRequestsGeoJson
    @GeoJson  NVARCHAR(MAX),
    @Replace  BIT = 1          -- 1 = clear and reload, 0 = upsert by ObjectID
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF ISJSON(@GeoJson) <> 1 OR JSON_VALUE(@GeoJson, N'$.type') <> N'FeatureCollection'
        THROW 50001, N'@GeoJson must be a GeoJSON FeatureCollection.', 1;

    BEGIN TRANSACTION;

    INSERT dbo.GeoJsonDocument (LayerName, Body) VALUES (N'ServiceRequests', @GeoJson);

    IF @Replace = 1
        DELETE FROM dbo.ServiceRequests;

    MERGE dbo.ServiceRequests AS t
    USING dbo.vw_ServiceRequests_GeoJson AS s
        ON t.ObjectID = s.ObjectID
    WHEN MATCHED THEN UPDATE SET
        RequestID = s.RequestID, Category = s.Category, RequestType = s.RequestType, Status = s.Status,
        Channel = s.Channel, Suburb = s.Suburb, Description = s.Description,
        DateLogged = s.DateLogged, DateCompleted = s.DateCompleted, Longitude = s.Longitude, Latitude = s.Latitude
    WHEN NOT MATCHED BY TARGET THEN INSERT
        (ObjectID, RequestID, Category, RequestType, Status, Channel, Suburb, Description, DateLogged, DateCompleted, Longitude, Latitude)
    VALUES
        (s.ObjectID, s.RequestID, s.Category, s.RequestType, s.Status, s.Channel, s.Suburb, s.Description, s.DateLogged, s.DateCompleted, s.Longitude, s.Latitude);

    COMMIT TRANSACTION;

    SELECT RowsLoaded = COUNT(*) FROM dbo.ServiceRequests;
END
GO

-- ---------------------------------------------------------------- USAGE
-- From .NET / Dapper:
--   await conn.ExecuteAsync("dbo.usp_ImportServiceRequestsGeoJson",
--       new { GeoJson = await File.ReadAllTextAsync(path), Replace = true },
--       commandType: CommandType.StoredProcedure);
--
-- From SSMS (file must be readable by the SQL Server service account; SQL 2019+ for CODEPAGE 65001):
--   DECLARE @json NVARCHAR(MAX) =
--       (SELECT BulkColumn FROM OPENROWSET(BULK N'C:\data\service_requests.geojson', SINGLE_CLOB, CODEPAGE = '65001') AS j);
--   EXEC dbo.usp_ImportServiceRequestsGeoJson @GeoJson = @json;
