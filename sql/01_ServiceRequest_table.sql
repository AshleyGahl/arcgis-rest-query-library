-- ============================================================================
-- 01  ServiceRequest table (SQL Server 2019+)
-- Same shape as the GeoJSON / mock FeatureServer layer (generic council
-- "report a problem" model — see docs/data-model.md), so the T-SQL in
-- vw_QueryLibrary can be run against identical data for comparison.
-- DtLogged / DtCompleted hold SAST local time (UTC+2), as the mock does.
-- ============================================================================
IF OBJECT_ID(N'dbo.ServiceRequest', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.ServiceRequest
    (
        ObjectID       INT            NOT NULL CONSTRAINT PK_ServiceRequest PRIMARY KEY,
        RequestID      NVARCHAR(20)   NULL,
        Category       NVARCHAR(50)   NULL,
        CategorySub    NVARCHAR(60)   NULL,
        Status         NVARCHAR(20)   NULL,     -- Open | In Progress | Closed
        Channel        NVARCHAR(20)   NULL,     -- App | Online form | Phone | Email | In person
        Suburb         NVARCHAR(60)   NULL,
        Description    NVARCHAR(600)  NULL,
        DtLogged     DATETIME2(0)   NULL,
        DtCompleted  DATETIME2(0)   NULL,
        Longitude      FLOAT          NULL,
        Latitude       FLOAT          NULL,
        Shape AS (CASE WHEN Latitude IS NOT NULL AND Longitude IS NOT NULL THEN GEOGRAPHY::Point(Latitude, Longitude, 4326) END)
    );

    CREATE INDEX IX_ServiceRequest_DtLogged ON dbo.ServiceRequest (DtLogged) INCLUDE (Category, Status, DtCompleted);
    CREATE INDEX IX_ServiceRequest_Category   ON dbo.ServiceRequest (Category, CategorySub) INCLUDE (Status);
    CREATE INDEX IX_ServiceRequest_Suburb     ON dbo.ServiceRequest (Suburb) INCLUDE (Status);
END
GO

-- Raw GeoJSON documents (one row per load). The view in 02 parses the latest one.
IF OBJECT_ID(N'dbo.GeoJsonDocument', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.GeoJsonDocument
    (
        DocumentId  INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_GeoJsonDocument PRIMARY KEY,
        LayerName   NVARCHAR(100)     NOT NULL,
        LoadedAt    DATETIME2(0)      NOT NULL CONSTRAINT DF_GeoJsonDocument_LoadedAt DEFAULT (SYSDATETIME()),
        Body        NVARCHAR(MAX)     NOT NULL CONSTRAINT CK_GeoJsonDocument_IsJson CHECK (ISJSON(Body) = 1)
    );
END
GO
