import { createContext, useContext } from 'react'
import { ALL_REPORTING_PERIOD } from './reportingPeriod'

export const ReportingPeriodContext = createContext(ALL_REPORTING_PERIOD)
export const useReportingPeriod = () => useContext(ReportingPeriodContext)
