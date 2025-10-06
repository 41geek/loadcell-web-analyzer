import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';

// FIX: Add Web Serial API type definitions to resolve TypeScript errors.
// These are typically provided by `@types/w3c-web-serial`, but are added here
// for self-containment as the project does not include them.
declare global {
    interface SerialPort {
        open(options: { baudRate: number }): Promise<void>;
        close(): Promise<void>;
        readonly readable: ReadableStream<Uint8Array> | null;
    }

    interface Navigator {
        serial: {
            requestPort(options?: any): Promise<SerialPort>;
        };
    }
}

// --- Type Definitions ---
interface Scale {
    id: number;
    name: string;
    rawValue: number;
    tareValue: number;
    calibrationSlope: number;
    category: 'none' | 'x' | '-x' | 'y' | '-y';
}

interface CalibrationPoint {
    knownWeight: number;
    rawValue: number;
}

interface LogEntry {
    totalX: number;
    totalY: number;
    processedValues: number[];
}

type CalibrationResult = {
    slope: number;
    rSquared: number;
};

type SerialStatus = {
    text: string;
    type: 'idle' | 'connected' | 'connecting' | 'error';
};

// --- Constants ---
const LOCAL_STORAGE_KEY = 'loadcellAnalyzerScalesConfig';

// --- Helper Functions ---

/**
 * Calculates linear regression for a set of data points.
 * @param points - Array of { x: knownWeight, y: measuredValue }
 * @returns { slope, rSquared }
 */
const calculateLinearRegression = (points: { x: number, y: number }[]): CalibrationResult => {
    if (points.length < 2) {
        return { slope: 1, rSquared: 0 };
    }

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    const n = points.length;

    points.forEach(({ x, y }) => {
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
        sumY2 += y * y;
    });

    const numeratorSlope = n * sumXY - sumX * sumY;
    const denominatorSlope = n * sumX2 - sumX * sumX;

    if (denominatorSlope === 0) {
        return { slope: 1, rSquared: 0 }; // Avoid division by zero
    }
    const slope = numeratorSlope / denominatorSlope;
    
    const numeratorR = (n * sumXY - sumX * sumY);
    const denominatorR = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    
    if (denominatorR === 0) {
        return { slope, rSquared: 1 };
    }

    const r = numeratorR / denominatorR;
    const rSquared = r * r;

    return { slope, rSquared: isNaN(rSquared) ? 0 : rSquared };
};

/**
 * Calculates the slope of a trendline for a time series of data.
 * @param data - Array of numbers.
 * @returns The slope of the trendline.
 */
const calculateTrendlineSlope = (data: number[]): number => {
    if (data.length < 2) return 0;
    const points = data.map((y, i) => ({ x: i, y }));
    const { slope } = calculateLinearRegression(points);
    return isNaN(slope) ? 0 : slope;
};


/**
 * Formats a number to 3 decimal places.
 */
const formatNumber = (num: number): string => num.toFixed(3);


// --- React Components ---

const DataChart = ({ data, title, color }: { data: number[], title: string, color: string }) => {
    const width = 100; // Viewbox width
    const height = 100; // Viewbox height
    const padding = 8;
    const textHeight = 15; // Space for the title

    if (data.length < 2) {
        return (
            <div className="chart-container">
                <svg viewBox={`0 0 ${width} ${height}`}>
                    <text x={width / 2} y={height / 2} className="chart-title">
                        {title}
                    </text>
                    <text x={width / 2} y={(height / 2) + 15} className="chart-waiting-text">
                        Waiting for data...
                    </text>
                </svg>
            </div>
        );
    }

    const maxVal = Math.max(...data);
    const minVal = Math.min(...data);
    const yRange = maxVal - minVal;

    const effectiveYRange = yRange === 0 ? 1 : yRange;

    const points = data.map((d, i) => {
        const x = (i / (data.length - 1)) * width;
        const y = (height - textHeight) - (((d - minVal) / effectiveYRange) * (height - textHeight - padding)) + (textHeight);
        return `${x},${y}`;
    }).join(' ');

    return (
        <div className="chart-container">
            <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
                <text x={width / 2} y={padding} className="chart-title">{title}</text>
                <polyline
                    className="line"
                    points={points}
                    style={{ stroke: color }}
                />
            </svg>
        </div>
    );
};


const CalibrationModal = ({
    scale,
    onClose,
    onApply,
}: {
    scale: Scale;
    onClose: () => void;
    onApply: (scaleId: number, newSlope: number) => void;
}) => {
    const [points, setPoints] = useState<CalibrationPoint[]>([]);
    const [knownWeight, setKnownWeight] = useState<string>('100');
    
    const regressionResult = useMemo(() => {
        const taredPoints = points.map(p => ({ x: p.knownWeight, y: p.rawValue - scale.tareValue }));
        return calculateLinearRegression(taredPoints);
    }, [points, scale.tareValue]);

    const addPoint = () => {
        const weight = parseFloat(knownWeight);
        if (isNaN(weight)) {
            alert('Please enter a valid number for weight.');
            return;
        }
        setPoints([...points, { knownWeight: weight, rawValue: scale.rawValue }]);
    };
    
    const handleApply = () => {
        if (regressionResult.slope !== 1) { // Check if calibration was done
            onApply(scale.id, regressionResult.slope);
        }
        onClose();
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>Calibrate {scale.name}</h2>
                    <button onClick={onClose} className="modal-close-btn">&times;</button>
                </div>
                
                <div className="calibration-form">
                    <input 
                        type="number"
                        value={knownWeight}
                        onChange={(e) => setKnownWeight(e.target.value)}
                        placeholder="Enter known weight (e.g., 100)"
                    />
                    <button onClick={addPoint}>Add Data Point (Current Raw: {formatNumber(scale.rawValue)})</button>
                </div>

                {points.length > 0 && (
                     <table className="data-points-table">
                        <thead>
                            <tr>
                                <th>Known Weight</th>
                                <th>Raw Value</th>
                                <th>Tared Value</th>
                            </tr>
                        </thead>
                        <tbody>
                            {points.map((p, i) => (
                                <tr key={i}>
                                    <td>{p.knownWeight}</td>
                                    <td>{formatNumber(p.rawValue)}</td>
                                    <td>{formatNumber(p.rawValue - scale.tareValue)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}

                {points.length > 1 && (
                    <div className="calibration-results">
                        <p>Calculated Slope (A): <span>{formatNumber(regressionResult.slope)}</span></p>
                        <p>Coefficient of Determination (R²): <span>{formatNumber(regressionResult.rSquared)}</span></p>
                    </div>
                )}
                
                <div className="modal-actions">
                    <button onClick={onClose}>Cancel</button>
                    <button onClick={handleApply} disabled={points.length < 2}>Apply Calibration</button>
                </div>
            </div>
        </div>
    );
};

const App = () => {
    const [scales, setScales] = useState<Scale[]>(() => {
        try {
            const savedConfig = localStorage.getItem(LOCAL_STORAGE_KEY);
            if (savedConfig) {
                const parsedConfig: Omit<Scale, 'rawValue'>[] = JSON.parse(savedConfig);
                if (Array.isArray(parsedConfig) && parsedConfig.length === 8) {
                    return parsedConfig.map(config => ({
                        ...config,
                        rawValue: 0, 
                    }));
                }
            }
        } catch (error) {
            console.error("Failed to load scales configuration from localStorage", error);
        }
        
        return Array.from({ length: 8 }, (_, i) => ({
            id: i + 1,
            name: `Scale ${i + 1}`,
            rawValue: 0,
            tareValue: 0,
            calibrationSlope: 1,
            category: 'none',
        }));
    });
    
    const [isSimulating, setIsSimulating] = useState(false);
    const [calibratingScaleId, setCalibratingScaleId] = useState<number | null>(null);
    
    const [log, setLog] = useState<LogEntry[]>([]);
    const [logBufferSize, setLogBufferSize] = useState(100);
    const logRef = useRef(log);
    logRef.current = log;
    
    const [copyButtonText, setCopyButtonText] = useState('Copy to Clipboard');

    const [serialStatus, setSerialStatus] = useState<SerialStatus>({text: 'Disconnected', type: 'idle'});
    const portRef = useRef<SerialPort | null>(null);
    const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
    const isReadingData = isSimulating || serialStatus.type === 'connected';

    const saveConfigToLocalStorage = (scalesToSave: Scale[]) => {
        try {
            const scalesConfig = scalesToSave.map(({ id, name, tareValue, calibrationSlope, category }) => ({
                id,
                name,
                tareValue,
                calibrationSlope,
                category,
            }));
            localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(scalesConfig));
        } catch (error) {
            console.error("Failed to save scales configuration to localStorage", error);
        }
    };

    useEffect(() => {
        if (!isSimulating) return;

        const intervalId = setInterval(() => {
            setScales(prevScales => 
                prevScales.map(scale => ({
                    ...scale,
                    rawValue: scale.rawValue + (Math.random() - 0.5) * 0.1,
                }))
            );
        }, 100); 

        return () => clearInterval(intervalId);
    }, [isSimulating]);
    
    const handleConnectDevice = useCallback(async () => {
        if (!('serial' in navigator)) {
            alert('Web Serial API not supported by your browser. Try Chrome or Edge.');
            return;
        }

        try {
            const port = await navigator.serial.requestPort();
            portRef.current = port;
            setSerialStatus({ text: 'Connecting...', type: 'connecting' });
            await port.open({ baudRate: 9600 });
            setSerialStatus({ text: 'Connected', type: 'connected' });
            
            readFromPort(port);

        } catch (error) {
            setSerialStatus({ text: `Error: ${(error as Error).message}`, type: 'error' });
            console.error('There was an error opening the serial port:', error);
        }
    }, []);

    const readFromPort = useCallback(async (port: SerialPort) => {
        const decoder = new TextDecoder();
        let lineBuffer = '';
        const reader = port.readable?.getReader();
        if (!reader) return;
        readerRef.current = reader;

        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                lineBuffer += chunk;
                
                let eolIndex;
                while ((eolIndex = lineBuffer.indexOf('\n')) >= 0) {
                    const line = lineBuffer.slice(0, eolIndex).trim();
                    lineBuffer = lineBuffer.slice(eolIndex + 1);

                    if (line) {
                        const values = line.split('\t').map(parseFloat);
                        if (values.length === 8 && values.every(v => !isNaN(v))) {
                            setScales(prevScales =>
                                prevScales.map((scale, index) => ({
                                    ...scale,
                                    rawValue: values[index],
                                }))
                            );
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('Read loop cancelled', error);
        } finally {
            reader.releaseLock();
        }
    }, []);
    
    const handleDisconnectDevice = useCallback(async () => {
        if (readerRef.current) {
            await readerRef.current.cancel();
            readerRef.current = null;
        }
        if (portRef.current) {
            await portRef.current.close();
            portRef.current = null;
        }
        setSerialStatus({ text: 'Disconnected', type: 'idle' });
    }, []);

    const { processedScales, totalX, totalY } = useMemo(() => {
        let x = 0;
        let y = 0;
        const processed = scales.map(s => {
            const processedValue = (s.rawValue - s.tareValue) * s.calibrationSlope;
            switch (s.category) {
                case 'x': x += processedValue; break;
                case '-x': x -= processedValue; break;
                case 'y': y += processedValue; break;
                case '-y': y -= processedValue; break;
            }
            return { ...s, processedValue };
        });
        return { processedScales: processed, totalX: x, totalY: y };
    }, [scales]);
    
    useEffect(() => {
        if (!isReadingData) return;
        
        const newLogEntry: LogEntry = {
            totalX,
            totalY,
            processedValues: processedScales.map(s => s.processedValue),
        };

        const updatedLog = [...logRef.current, newLogEntry];

        if (updatedLog.length > logBufferSize) {
           updatedLog.shift();
        }
        setLog(updatedLog);

    }, [totalX, totalY, processedScales, isReadingData, logBufferSize]);

    const stabilitySlopes = useMemo(() => {
        const recentLog = log.slice(-20);
        if (recentLog.length < 2) {
            return {
                scales: Array(8).fill(0),
                totalX: 0,
                totalY: 0,
            };
        }
    
        const scaleSlopes = Array.from({ length: 8 }, (_, scaleIndex) => {
            const scaleData = recentLog.map(entry => entry.processedValues[scaleIndex] ?? 0);
            return calculateTrendlineSlope(scaleData) * 100;
        });
    
        const totalXSlope = calculateTrendlineSlope(recentLog.map(entry => entry.totalX)) * 100;
        const totalYSlope = calculateTrendlineSlope(recentLog.map(entry => entry.totalY)) * 100;
    
        return {
            scales: scaleSlopes,
            totalX: totalXSlope,
            totalY: totalYSlope,
        };
    }, [log]);

    const handleTareAll = useCallback(() => {
        setScales(prevScales => {
            const updatedScales = prevScales.map(scale => ({
                ...scale,
                tareValue: scale.rawValue,
            }));
            saveConfigToLocalStorage(updatedScales);
            return updatedScales;
        });
    }, []);
    
    const handleCategoryChange = useCallback((id: number, newCategory: Scale['category']) => {
        setScales(prevScales => {
            const updatedScales = prevScales.map(scale =>
                scale.id === id ? { ...scale, category: newCategory } : scale
            );
            saveConfigToLocalStorage(updatedScales);
            return updatedScales;
        });
    }, []);

    const handleApplyCalibration = useCallback((id: number, newSlope: number) => {
        setScales(prevScales => {
            const updatedScales = prevScales.map(scale =>
                scale.id === id ? {...scale, calibrationSlope: newSlope} : scale
            );
            saveConfigToLocalStorage(updatedScales);
            return updatedScales;
        });
    }, []);

    const handleCopyToClipboard = async () => {
        if (log.length === 0) {
            alert("No data to copy.");
            return;
        }
        const scaleHeaders = scales.map(s => s.name.replace(/ /g, "_")).join('\t');
        const header = `X_Total\tY_Total\t${scaleHeaders}\n`;
        const rows = log.map(entry => {
            const scaleValues = entry.processedValues.map(formatNumber).join('\t');
            return `${formatNumber(entry.totalX)}\t${formatNumber(entry.totalY)}\t${scaleValues}`;
        }).join('\n');
        
        const excelContent = header + rows;
        
        try {
            await navigator.clipboard.writeText(excelContent);
            setCopyButtonText('Copied!');
            setTimeout(() => setCopyButtonText('Copy to Clipboard'), 2000);
        } catch (err) {
            console.error('Failed to copy text: ', err);
            alert('Failed to copy data to clipboard.');
        }
    };

    const calibratingScale = useMemo(() =>
        scales.find(s => s.id === calibratingScaleId) || null
    , [scales, calibratingScaleId]);

    return (
        <div className="app-container">
            <h1>Loadcell Data Analyzer</h1>
            
            <div className="main-controls">
                <button onClick={() => setIsSimulating(s => !s)} disabled={serialStatus.type === 'connected'}>
                    {isSimulating ? 'Stop Simulation' : 'Start Simulation'}
                </button>
                <button onClick={serialStatus.type === 'connected' ? handleDisconnectDevice : handleConnectDevice} disabled={isSimulating}>
                    {serialStatus.type === 'connected' ? 'Disconnect Device' : 'Connect to Device'}
                </button>
                <div className={`serial-status ${serialStatus.type}`}>{serialStatus.text}</div>
                <button onClick={handleTareAll} disabled={!isReadingData}>Tare All</button>
            </div>

            <div className="totals-display">
                <div className="total-card">
                    <h2>X-Direction Total</h2>
                    <p className="value">{formatNumber(totalX)}</p>
                    <p className="stability-slope">Slope: {formatNumber(stabilitySlopes.totalX)}</p>
                </div>
                <div className="total-card">
                    <h2>Y-Direction Total</h2>
                    <p className="value">{formatNumber(totalY)}</p>
                    <p className="stability-slope">Slope: {formatNumber(stabilitySlopes.totalY)}</p>
                </div>
            </div>

            <div className="charts-display">
                <DataChart 
                    title="X Total History"
                    data={log.map(e => e.totalX)}
                    color="var(--primary-color)"
                />
                <DataChart 
                    title="Y Total History"
                    data={log.map(e => e.totalY)}
                    color="var(--secondary-color)"
                />
            </div>

            <div className="scales-section">
                <h2>Individual Scales</h2>
                <table className="scales-table">
                    <thead>
                        <tr>
                            <th>Scale</th>
                            <th>Raw Value</th>
                            <th>Processed Value</th>
                            <th>Stability (Slope)</th>
                            <th>Category</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {processedScales.map((scale, index) => (
                            <tr key={scale.id}>
                                <td>{scale.name}</td>
                                <td>{formatNumber(scale.rawValue)}</td>
                                <td>{formatNumber(scale.processedValue)}</td>
                                <td className="stability-slope-cell">{formatNumber(stabilitySlopes.scales[index])}</td>
                                <td>
                                    <select 
                                        value={scale.category} 
                                        onChange={(e) => handleCategoryChange(scale.id, e.target.value as Scale['category'])}
                                    >
                                        <option value="none">None</option>
                                        <option value="x">X</option>
                                        <option value="-x">-X</option>
                                        <option value="y">Y</option>
                                        <option value="-y">-Y</option>
                                    </select>
                                </td>
                                <td>
                                    <button onClick={() => setCalibratingScaleId(scale.id)} disabled={!isReadingData}>Calibrate</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            
            <div className="logging-section">
                <h2>Data Logging</h2>
                 <div className="logging-controls">
                    <label htmlFor="buffer-size">Buffer Size:</label>
                    <input 
                        id="buffer-size"
                        type="number" 
                        value={logBufferSize}
                        onChange={e => setLogBufferSize(parseInt(e.target.value) || 100)}
                    />
                    <button onClick={handleCopyToClipboard} disabled={log.length === 0}>{copyButtonText}</button>
                </div>
                <div className="log-display" aria-live="polite">
                    {log.slice(-10).reverse().map((entry, index) => (
                        <div key={log.length - index}>X: {formatNumber(entry.totalX)}, Y: {formatNumber(entry.totalY)}</div>
                    ))}
                    {log.length > 10 && <div>...and {log.length-10} more entries</div>}
                </div>
            </div>

            {calibratingScale && (
                <CalibrationModal 
                    scale={calibratingScale}
                    onClose={() => setCalibratingScaleId(null)}
                    onApply={handleApplyCalibration}
                />
            )}
        </div>
    );
};

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<App />);
}
