'use strict'

const cds = require('@sap/cds')
const { getPartInfo } = require('./parts-catalog')
const { createLogger } = require('./logger')

const LOG = createLogger('petrobras.maintenance')

/**
 * MaintenanceService — Custom Handlers
 *
 * Session 01 handlers:
 *   1. before CREATE  MaintenanceOrders — Equipment must be ACTIVE
 *   2. before UPDATE  MaintenanceOrders — State-machine transition guard
 *   3. after  UPDATE  WorkItems         — Auto-close order when all items COMPLETED
 *
 * Session 02 handlers:
 *   4. before CREATE  WorkItems         — Validate partCode via SparePartsAPI
 *
 * Session 03 additions:
 *   · Handler 3 extended: emit MaintenanceOrderCompleted domain event
 *   · In-process subscriber: logs event + ready to forward to external system
 *   · All handlers instrumented with structured logging
 */
module.exports = class MaintenanceService extends cds.ApplicationService {

    async init() {
        const { MaintenanceOrders, WorkItems, Equipment } = this.entities

        const ALLOWED_TRANSITIONS = {
            DRAFT:       ['OPEN', 'CANCELLED'],
            OPEN:        ['IN_PROGRESS', 'CANCELLED'],
            IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
            COMPLETED:   [],
            CANCELLED:   []
        }

        // ── Session 03: Subscribe to own domain event ──────────────────────────
        // In-process subscriber — runs in the same Node.js process.
        // In production, replace with an SAP Event Mesh subscriber via cds.outbox().
        this.on('MaintenanceOrderCompleted', async (msg) => {
            const { orderID, orderNumber, equipmentID, completedAt, totalItems } = msg.data
            LOG.event('MaintenanceOrderCompleted received', {
                orderID, orderNumber, equipmentID, completedAt, totalItems
            })
            // Production hook: await assetMgmt.notify({ orderID, equipmentID })
        })

        // ── Handler 1: Equipment must be ACTIVE ────────────────────────────────
        this.before('CREATE', MaintenanceOrders, async (req) => {
            const { equipment_ID } = req.data
            if (!equipment_ID)
                return req.error(400, 'equipment_ID is required.')

            const eq = await SELECT.one.from(Equipment)
                .columns('ID', 'code', 'status').where({ ID: equipment_ID })

            if (!eq)
                return req.error(404, `Equipment '${equipment_ID}' not found.`)

            if (eq.status !== 'ACTIVE') {
                LOG.warn('Order creation rejected — equipment not ACTIVE', {
                    equipmentID: equipment_ID, status: eq.status
                })
                return req.error(422,
                    `Equipment '${eq.code}' is ${eq.status}. ` +
                    `Only ACTIVE equipment accepts maintenance orders.`)
            }
        })

        // ── Handler 2: State-machine transition guard ──────────────────────────
        this.before('UPDATE', MaintenanceOrders, async (req) => {
            const newStatus = req.data.status
            if (!newStatus) return

            const id = req.data?.ID ?? req.params?.[0]?.ID
            if (!id) return

            const order = await SELECT.one.from(MaintenanceOrders)
                .columns('ID', 'orderNumber', 'status').where({ ID: id })

            if (!order) return req.error(404, 'Maintenance order not found.')

            const allowed = ALLOWED_TRANSITIONS[order.status] ?? []
            if (!allowed.includes(newStatus)) {
                LOG.warn('Invalid status transition rejected', {
                    orderNumber: order.orderNumber,
                    from: order.status, to: newStatus,
                    allowed
                })
                return req.error(422,
                    `Order '${order.orderNumber}' cannot transition from ` +
                    `${order.status} to ${newStatus}. ` +
                    `Allowed: [${allowed.join(', ') || 'none'}].`)
            }
        })

        // ── Handler 3: Auto-close + emit domain event ──────────────────────────
        this.after('UPDATE', WorkItems, async (_, req) => {
            const id = req.data?.ID ?? req.params?.[0]?.ID
            if (!id) return

            const item = await SELECT.one.from(WorkItems)
                .columns('order_ID').where({ ID: id })
            if (!item?.order_ID) return

            const siblings = await SELECT.from(WorkItems)
                .columns('status').where({ order_ID: item.order_ID })

            const allDone = siblings.length > 0 &&
                siblings.every(w => w.status === 'COMPLETED')

            if (allDone) {
                await UPDATE(MaintenanceOrders)
                    .set({ status: 'COMPLETED' })
                    .where({ ID: item.order_ID })

                // ── Session 03: Emit domain event ──────────────────────────────
                const order = await SELECT.one.from(MaintenanceOrders)
                    .columns('ID', 'orderNumber', 'equipment_ID')
                    .where({ ID: item.order_ID })

                // Use cds.outbox() in production for guaranteed-once delivery.
                // In-process emit is sufficient for development and workshops.
                await this.emit('MaintenanceOrderCompleted', {
                    orderID:     order.ID,
                    orderNumber: order.orderNumber,
                    equipmentID: order.equipment_ID,
                    completedAt: new Date().toISOString(),
                    totalItems:  siblings.length
                })

                LOG.info('Order auto-closed and event emitted', {
                    orderID: order.ID, orderNumber: order.orderNumber,
                    totalItems: siblings.length
                })
            }
        })

        // ── Handler 4: Validate spare part via SparePartsAPI ──────────────────
        this.before('CREATE', WorkItems, async (req) => {
            const { partCode } = req.data
            if (!partCode?.trim()) return

            try {
                const part = await getPartInfo(partCode)
                if (!part || !part.available) {
                    return req.error(422,
                        `Part '${partCode}' is not available in the catalog. ` +
                        `Please choose an available spare part or leave partCode empty.`)
                }
            } catch (err) {
                req.warn(503,
                    `Spare parts catalog is temporarily unavailable. ` +
                    `Work item created without part validation.`)
            }
        })

        return super.init()
    }
}
