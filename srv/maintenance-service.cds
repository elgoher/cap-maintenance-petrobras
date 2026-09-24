using { petrobras.maintenance as db } from '../db/schema';

/**
 * MaintenanceService
 *
 * Session 01: base service — model, projections, CQL
 * Session 02: @requires + @restrict, SparePartsAPI, resilience
 * Session 03: domain events (MaintenanceOrderCompleted)
 */
service MaintenanceService @(
    path    : '/maintenance',
    requires: 'authenticated-user'
) {

    @readonly
    entity Equipment as projection on db.Equipment
        excluding { orders };

    @(restrict: [
        { grant: 'READ',  to: ['MaintenanceViewer', 'MaintenanceAdmin'] },
        { grant: 'WRITE', to: 'MaintenanceAdmin' }
    ])
    entity MaintenanceOrders as projection on db.MaintenanceOrder {
        *,
        equipment : redirected to Equipment,
        workItems : redirected to WorkItems
    };

    @(restrict: [
        { grant: 'READ',  to: ['MaintenanceViewer', 'MaintenanceAdmin'] },
        { grant: 'WRITE', to: 'MaintenanceAdmin' }
    ])
    entity WorkItems as projection on db.WorkItem {
        *,
        order : redirected to MaintenanceOrders
    };

    // ── Session 03: Domain Events ─────────────────────────────────────────────
    //
    // Emitted by: after UPDATE WorkItems handler (auto-close logic)
    // Payload:    order identity + completion metadata
    //
    // Consumers:
    //   · In-process subscriber in srv/maintenance-service.js (logging / alerting)
    //   · Production: SAP Event Mesh / BTP Messaging via cds.outbox()

    event MaintenanceOrderCompleted {
        orderID     : UUID;
        orderNumber : String(20);
        equipmentID : UUID;
        completedAt : Timestamp;
        totalItems  : Integer;
    }
}
