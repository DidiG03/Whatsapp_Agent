

import cluster from 'cluster';
import os from 'os';
import { logHelpers } from '../monitoring/logger.mjs';
import { businessMetrics } from '../monitoring/metrics.mjs';
const clusterConfig = {
  enabled: process.env.CLUSTER_ENABLED === 'true',
  workers: parseInt(process.env.CLUSTER_WORKERS || os.cpus().length),
  maxMemory: parseInt(process.env.CLUSTER_MAX_MEMORY || '512') * 1024 * 1024,  restartDelay: parseInt(process.env.CLUSTER_RESTART_DELAY || '5000'),
  maxRestarts: parseInt(process.env.CLUSTER_MAX_RESTARTS || '10'),
  gracefulShutdownTimeout: parseInt(process.env.CLUSTER_SHUTDOWN_TIMEOUT || '30000')
};
const workers = new Map();
let restartCount = 0;
let isShuttingDown = false;
const loadBalancerConfig = {
  algorithm: process.env.LB_ALGORITHM || 'round_robin',  healthCheckInterval: parseInt(process.env.LB_HEALTH_CHECK_INTERVAL || '30000'),
  healthCheckTimeout: parseInt(process.env.LB_HEALTH_CHECK_TIMEOUT || '5000'),
  unhealthyThreshold: parseInt(process.env.LB_UNHEALTHY_THRESHOLD || '3'),
  healthyThreshold: parseInt(process.env.LB_HEALTHY_THRESHOLD || '2')
};
const workerHealth = new Map();

export const clusterManager = {
  init() {
    if (!clusterConfig.enabled) {
      logHelpers.logBusinessEvent('cluster_disabled');
      return false;
    }
    
    if (cluster.isMaster) {
      return this.initMaster();
    } else {
      return this.initWorker();
    }
  },
  initMaster() {
    logHelpers.logBusinessEvent('cluster_master_started', {
      workers: clusterConfig.workers,
      maxMemory: clusterConfig.maxMemory,
      algorithm: loadBalancerConfig.algorithm
    });
    for (let i = 0; i < clusterConfig.workers; i++) {
      this.forkWorker();
    }
    cluster.on('fork', (worker) => {
      logHelpers.logBusinessEvent('cluster_worker_forked', {
        workerId: worker.id,
        pid: worker.process.pid
      });
      
      workers.set(worker.id, {
        worker,
        startTime: Date.now(),
        restarts: 0,
        health: 'unknown'
      });
      
      workerHealth.set(worker.id, {
        status: 'healthy',
        lastCheck: Date.now(),
        consecutiveFailures: 0,
        consecutiveSuccesses: 0
      });
    });
    
    cluster.on('online', (worker) => {
      logHelpers.logBusinessEvent('cluster_worker_online', {
        workerId: worker.id,
        pid: worker.process.pid
      });
      
      const workerData = workers.get(worker.id);
      if (workerData) {
        workerData.health = 'healthy';
      }
    });
    
    cluster.on('exit', (worker, code, signal) => {
      logHelpers.logBusinessEvent('cluster_worker_exited', {
        workerId: worker.id,
        pid: worker.process.pid,
        code,
        signal,
        isShuttingDown
      });
      
      workers.delete(worker.id);
      workerHealth.delete(worker.id);
      if (!isShuttingDown && !worker.exitedAfterDisconnect) {
        setTimeout(() => {
          this.forkWorker();
        }, clusterConfig.restartDelay);
      }
    });
    process.on('SIGTERM', () => this.gracefulShutdown());
    process.on('SIGINT', () => this.gracefulShutdown());
    this.startHealthChecks();
    
    return true;
  },
  initWorker() {
    logHelpers.logBusinessEvent('cluster_worker_started', {
      workerId: cluster.worker.id,
      pid: process.pid
    });
    process.on('SIGTERM', () => this.gracefulWorkerShutdown());
    process.on('SIGINT', () => this.gracefulWorkerShutdown());
    setInterval(() => {
      const memUsage = process.memoryUsage();
      if (memUsage.heapUsed > clusterConfig.maxMemory) {
        logHelpers.logError(new Error('Worker memory limit exceeded'), {
          component: 'cluster',
          workerId: cluster.worker.id,
          memoryUsage: memUsage.heapUsed,
          maxMemory: clusterConfig.maxMemory
        });
        process.exit(1);
      }
    }, 30000);    
    return true;
  },
  forkWorker() {
    if (restartCount >= clusterConfig.maxRestarts) {
      logHelpers.logError(new Error('Maximum restart limit reached'), {
        component: 'cluster',
        restartCount
      });
      return null;
    }
    
    const worker = cluster.fork();
    restartCount++;
    
    return worker;
  },
  startHealthChecks() {
    setInterval(() => {
      this.performHealthChecks();
    }, loadBalancerConfig.healthCheckInterval);
  },
  performHealthChecks() {
    for (const [workerId, healthData] of workerHealth) {
      this.checkWorkerHealth(workerId, healthData);
    }
  },
  checkWorkerHealth(workerId, healthData) {
    const worker = workers.get(workerId);
    if (!worker) return;
    
    const startTime = Date.now();
    worker.worker.send({ type: 'ping', timestamp: startTime });
    const timeout = setTimeout(() => {
      this.handleWorkerHealthFailure(workerId, 'timeout');
    }, loadBalancerConfig.healthCheckTimeout);
    const pongHandler = (message) => {
      if (message.type === 'pong' && message.timestamp === startTime) {
        clearTimeout(timeout);
        worker.worker.removeListener('message', pongHandler);
        this.handleWorkerHealthSuccess(workerId);
      }
    };
    
    worker.worker.on('message', pongHandler);
  },
  handleWorkerHealthSuccess(workerId) {
    const healthData = workerHealth.get(workerId);
    if (!healthData) return;
    
    healthData.consecutiveSuccesses++;
    healthData.consecutiveFailures = 0;
    healthData.lastCheck = Date.now();
    
    if (healthData.status === 'unhealthy' && 
        healthData.consecutiveSuccesses >= loadBalancerConfig.healthyThreshold) {
      healthData.status = 'healthy';
      
      logHelpers.logBusinessEvent('cluster_worker_recovered', {
        workerId,
        consecutiveSuccesses: healthData.consecutiveSuccesses
      });
    }
  },
  handleWorkerHealthFailure(workerId, reason) {
    const healthData = workerHealth.get(workerId);
    if (!healthData) return;
    
    healthData.consecutiveFailures++;
    healthData.consecutiveSuccesses = 0;
    healthData.lastCheck = Date.now();
    
    if (healthData.status === 'healthy' && 
        healthData.consecutiveFailures >= loadBalancerConfig.unhealthyThreshold) {
      healthData.status = 'unhealthy';
      
      logHelpers.logBusinessEvent('cluster_worker_unhealthy', {
        workerId,
        reason,
        consecutiveFailures: healthData.consecutiveFailures
      });
      this.restartWorker(workerId);
    }
  },
  restartWorker(workerId) {
    const workerData = workers.get(workerId);
    if (!workerData) return;
    
    logHelpers.logBusinessEvent('cluster_worker_restart', {
      workerId,
      pid: workerData.worker.process.pid,
      restarts: workerData.restarts
    });
    
    workerData.restarts++;
    workerData.worker.disconnect();
  },
  gracefulShutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    logHelpers.logBusinessEvent('cluster_graceful_shutdown_started');
    for (const [workerId, workerData] of workers) {
      workerData.worker.disconnect();
    }
    setTimeout(() => {
      logHelpers.logBusinessEvent('cluster_force_shutdown');
      process.exit(0);
    }, clusterConfig.gracefulShutdownTimeout);
  },
  gracefulWorkerShutdown() {
    logHelpers.logBusinessEvent('cluster_worker_graceful_shutdown', {
      workerId: cluster.worker.id,
      pid: process.pid
    });
    if (global.server) {
      global.server.close(() => {
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  },
  getStats() {
    const stats = {
      isMaster: cluster.isMaster,
      workers: workers.size,
      workerDetails: [],
      healthSummary: {
        healthy: 0,
        unhealthy: 0,
        unknown: 0
      }
    };
    
    for (const [workerId, workerData] of workers) {
      const healthData = workerHealth.get(workerId);
      const memUsage = workerData.worker.process.memoryUsage();
      
      stats.workerDetails.push({
        workerId,
        pid: workerData.worker.process.pid,
        uptime: Date.now() - workerData.startTime,
        restarts: workerData.restarts,
        health: healthData?.status || 'unknown',
        memoryUsage: memUsage.heapUsed,
        memoryLimit: clusterConfig.maxMemory
      });
      
      if (healthData) {
        stats.healthSummary[healthData.status]++;
      } else {
        stats.healthSummary.unknown++;
      }
    }
    
    return stats;
  }
};
export const loadBalancer = {
  getNextWorker() {
    const healthyWorkers = Array.from(workers.values())
      .filter(workerData => {
        const healthData = workerHealth.get(workerData.worker.id);
        return healthData?.status === 'healthy';
      });
    
    if (healthyWorkers.length === 0) {
      return null;
    }
    const index = Math.floor(Math.random() * healthyWorkers.length);
    return healthyWorkers[index].worker;
  },
  getLeastBusyWorker() {
    const healthyWorkers = Array.from(workers.values())
      .filter(workerData => {
        const healthData = workerHealth.get(workerData.worker.id);
        return healthData?.status === 'healthy';
      });
    
    if (healthyWorkers.length === 0) {
      return null;
    }
    return healthyWorkers.reduce((least, current) => 
      current.restarts < least.restarts ? current : least
    ).worker;
  },
  distributeLoad(algorithm = loadBalancerConfig.algorithm) {
    switch (algorithm) {
      case 'round_robin':
        return this.getNextWorker();
      case 'least_connections':
        return this.getLeastBusyWorker();
      default:
        return this.getNextWorker();
    }
  }
};
export const processMonitor = {
  startMonitoring() {
    setInterval(() => {
      this.collectMetrics();
    }, 30000);  },
  collectMetrics() {
    const metrics = {
      cpu: process.cpuUsage(),
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      pid: process.pid,
      platform: process.platform,
      nodeVersion: process.version
    };
    
    businessMetrics.logBusinessEvent('process_metrics', metrics);
    
    return metrics;
  }
};
if (cluster.isWorker) {
  process.on('message', (message) => {
    if (message.type === 'ping') {
      process.send({ type: 'pong', timestamp: message.timestamp });
    }
  });
}

export default {
  clusterManager,
  loadBalancer,
  processMonitor
};
