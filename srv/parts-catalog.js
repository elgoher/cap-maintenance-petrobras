'use strict'

const cds = require('@sap/cds')
const { createLogger } = require('./logger')

const LOG = createLogger('petrobras.parts-catalog')

/**
 * SparePartsAPI client — Session 03 adds structured logging.
 *
 * Logs every call with service name, path, duration and outcome.
 * This data feeds into BTP Application Logging Service in production.
 */
async function getPartInfo(partCode) {
    const start = Date.now()
    const api   = await cds.connect.to('SparePartsAPI')

    try {
        const data = await api.send({
            method: 'GET',
            path:   `/parts/${encodeURIComponent(partCode)}`
        })
        LOG.apiCall('SparePartsAPI', `/parts/${partCode}`, Date.now() - start, 'ok')
        return data
    } catch (err) {
        LOG.apiCall('SparePartsAPI', `/parts/${partCode}`, Date.now() - start, 'unavailable')
        throw err
    }
}

module.exports = { getPartInfo }
