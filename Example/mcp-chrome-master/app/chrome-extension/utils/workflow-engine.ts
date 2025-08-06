/**
 * Workflow Orchestration Engine
 * Handles complex multi-step browser automation workflows with dependencies,
 * error handling, retries, and state management.
 */

import { 
  WorkflowDefinition, 
  WorkflowStep, 
  WorkflowExecution, 
  WorkflowStepResult,
  WaitCondition 
} from 'chrome-mcp-shared';
import { handleCallTool, type ToolCallParam } from '@/entrypoints/background/tools';
import { createErrorResponse } from '@/common/tool-handler';

export class WorkflowEngine {
  private executions = new Map<string, WorkflowExecution>();
  private executionCounter = 0;

  /**
   * Execute a workflow with full orchestration support
   */
  async executeWorkflow(workflow: WorkflowDefinition): Promise<WorkflowExecution> {
    const executionId = `workflow_${++this.executionCounter}_${Date.now()}`;
    
    const execution: WorkflowExecution = {
      id: executionId,
      workflow,
      status: 'running',
      startTime: Date.now(),
      completedSteps: [],
      failedSteps: [],
      variables: { ...workflow.variables } || {},
      results: {},
      errors: []
    };

    this.executions.set(executionId, execution);

    console.log(`Starting workflow execution: ${workflow.name} (${executionId})`);

    try {
      await this.executeSteps(execution);
      
      execution.status = 'completed';
      execution.endTime = Date.now();
      
      console.log(`Workflow completed successfully: ${workflow.name} in ${execution.endTime - execution.startTime}ms`);
      
    } catch (error) {
      execution.status = 'failed';
      execution.endTime = Date.now();
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Workflow failed: ${workflow.name} - ${errorMessage}`);
      
      // Handle rollback if configured
      if (workflow.errorHandling?.strategy === 'rollback_on_error') {
        await this.performRollback(execution);
      }
      
      throw error;
    }

    return execution;
  }

  /**
   * Execute workflow steps with dependency resolution and parallel execution
   */
  private async executeSteps(execution: WorkflowExecution): Promise<void> {
    const { workflow } = execution;
    const { steps } = workflow;
    
    // Build dependency graph
    const dependencyGraph = this.buildDependencyGraph(steps);
    const executionOrder = this.topologicalSort(dependencyGraph);
    
    // Group steps that can be executed in parallel
    const executionGroups = this.groupParallelSteps(executionOrder, dependencyGraph);
    
    console.log(`Executing workflow in ${executionGroups.length} parallel groups`);
    
    for (const group of executionGroups) {
      // Execute steps in parallel within each group
      const promises = group.map(stepId => this.executeStep(execution, stepId));
      
      try {
        await Promise.all(promises);
      } catch (error) {
        // Handle group-level errors based on strategy
        if (workflow.errorHandling?.strategy === 'fail_fast') {
          throw error;
        }
        
        console.warn(`Group execution had failures, continuing based on error strategy`);
      }
    }
  }

  /**
   * Execute a single workflow step with retry and error handling
   */
  private async executeStep(execution: WorkflowExecution, stepId: string): Promise<WorkflowStepResult> {
    const step = execution.workflow.steps.find(s => s.id === stepId);
    if (!step) {
      throw new Error(`Step not found: ${stepId}`);
    }

    execution.currentStep = stepId;
    console.log(`Executing step: ${stepId} (${step.tool})`);

    const startTime = Date.now();
    let lastError: Error | null = null;
    let retryAttempt = 0;
    const maxRetries = step.retryCount || 0;

    while (retryAttempt <= maxRetries) {
      try {
        // Check step condition if specified
        if (step.condition && !this.evaluateCondition(step.condition, execution.variables)) {
          console.log(`Skipping step ${stepId} due to condition: ${step.condition}`);
          return {
            stepId,
            success: true,
            result: { skipped: true, reason: 'condition not met' },
            executionTime: Date.now() - startTime
          };
        }

        // Substitute variables in step arguments
        const resolvedArgs = this.substituteVariables(step.args, execution.variables);

        // Execute the tool
        const toolCall: ToolCallParam = {
          name: step.tool,
          args: resolvedArgs
        };

        const toolResult = await this.executeWithTimeout(
          () => handleCallTool(toolCall),
          step.timeout || 30000
        );

        if (toolResult.isError) {
          throw new Error(`Tool execution failed: ${toolResult.content[0]?.text || 'Unknown error'}`);
        }

        // Parse result and update variables
        let result = toolResult.content[0]?.text;
        try {
          result = JSON.parse(result);
        } catch {
          // Keep as string if not JSON
        }

        // Store result for use by other steps
        execution.results[stepId] = result;
        
        // Update variables with step results if specified
        if (step.args.storeAs && typeof step.args.storeAs === 'string') {
          execution.variables[step.args.storeAs] = result;
        }

        // Wait for condition if specified
        if (step.waitFor) {
          await this.waitForCondition(step.waitFor);
        }

        execution.completedSteps.push(stepId);

        const stepResult: WorkflowStepResult = {
          stepId,
          success: true,
          result,
          executionTime: Date.now() - startTime,
          retryAttempt: retryAttempt > 0 ? retryAttempt : undefined
        };

        console.log(`Step completed successfully: ${stepId} in ${stepResult.executionTime}ms`);
        return stepResult;

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        retryAttempt++;

        console.error(`Step ${stepId} failed (attempt ${retryAttempt}/${maxRetries + 1}): ${lastError.message}`);

        execution.errors.push({
          stepId,
          error: lastError.message,
          timestamp: Date.now(),
          retryAttempt
        });

        // Handle error based on step configuration
        if (step.onError === 'continue') {
          console.log(`Continuing despite error in step: ${stepId}`);
          execution.failedSteps.push(stepId);
          return {
            stepId,
            success: false,
            error: lastError.message,
            executionTime: Date.now() - startTime,
            retryAttempt
          };
        }

        if (retryAttempt <= maxRetries) {
          const delay = step.retryDelay || 1000;
          console.log(`Retrying step ${stepId} in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // All retries exhausted
    execution.failedSteps.push(stepId);
    
    if (step.onError === 'rollback') {
      throw new Error(`Step ${stepId} failed and requires rollback: ${lastError?.message}`);
    }

    throw lastError || new Error(`Step ${stepId} failed after ${maxRetries + 1} attempts`);
  }

  /**
   * Wait for a specific condition to be met
   */
  private async waitForCondition(condition: WaitCondition): Promise<void> {
    const timeout = condition.timeout || 30000;
    const interval = condition.interval || 500;
    const startTime = Date.now();

    console.log(`Waiting for condition: ${condition.type}`);

    while (Date.now() - startTime < timeout) {
      try {
        let conditionMet = false;

        switch (condition.type) {
          case 'element':
            conditionMet = await this.checkElementCondition(condition);
            break;
            
          case 'network_idle':
            conditionMet = await this.checkNetworkIdle();
            break;
            
          case 'navigation':
            conditionMet = await this.checkNavigationCondition(condition);
            break;
            
          case 'custom':
            conditionMet = await this.checkCustomCondition(condition);
            break;
        }

        if (conditionMet) {
          console.log(`Condition met: ${condition.type}`);
          return;
        }

        await new Promise(resolve => setTimeout(resolve, interval));
      } catch (error) {
        console.warn(`Error checking condition: ${error}`);
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }

    throw new Error(`Condition timeout: ${condition.type} after ${timeout}ms`);
  }

  /**
   * Check element-based conditions
   */
  private async checkElementCondition(condition: WaitCondition): Promise<boolean> {
    if (!condition.selector) return false;

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]?.id) return false;

      const result = await chrome.tabs.sendMessage(tabs[0].id, {
        action: 'check_element_condition',
        selector: condition.selector,
        state: condition.state,
        text: condition.text
      });

      return result?.conditionMet === true;
    } catch {
      return false;
    }
  }

  /**
   * Check if network is idle
   */
  private async checkNetworkIdle(): Promise<boolean> {
    // Implementation would check for absence of network activity
    // This is a simplified version
    return new Promise(resolve => {
      setTimeout(() => resolve(true), 1000);
    });
  }

  /**
   * Check navigation-based conditions
   */
  private async checkNavigationCondition(condition: WaitCondition): Promise<boolean> {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]?.url) return false;

      if (condition.url) {
        return tabs[0].url.includes(condition.url);
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check custom JavaScript conditions
   */
  private async checkCustomCondition(condition: WaitCondition): Promise<boolean> {
    if (!condition.javascript) return false;

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]?.id) return false;

      const result = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: (js: string) => {
          try {
            return eval(js);
          } catch {
            return false;
          }
        },
        args: [condition.javascript]
      });

      return result[0]?.result === true;
    } catch {
      return false;
    }
  }

  /**
   * Execute function with timeout
   */
  private async executeWithTimeout<T>(fn: () => Promise<T>, timeout: number): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error(`Operation timed out after ${timeout}ms`)), timeout)
      )
    ]);
  }

  /**
   * Substitute variables in object using {{variable}} syntax
   */
  private substituteVariables(obj: any, variables: Record<string, any>): any {
    if (typeof obj === 'string') {
      return obj.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
        return variables[varName] !== undefined ? String(variables[varName]) : match;
      });
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.substituteVariables(item, variables));
    }
    
    if (obj && typeof obj === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.substituteVariables(value, variables);
      }
      return result;
    }
    
    return obj;
  }

  /**
   * Evaluate simple conditions
   */
  private evaluateCondition(condition: string, variables: Record<string, any>): boolean {
    try {
      // Simple variable substitution and evaluation
      const resolved = this.substituteVariables(condition, variables);
      
      // Basic condition evaluation (can be enhanced)
      if (resolved.includes('>')) {
        const [left, right] = resolved.split('>').map(s => s.trim());
        return Number(left) > Number(right);
      }
      
      if (resolved.includes('<')) {
        const [left, right] = resolved.split('<').map(s => s.trim());
        return Number(left) < Number(right);
      }
      
      if (resolved.includes('==')) {
        const [left, right] = resolved.split('==').map(s => s.trim());
        return left === right;
      }
      
      // Boolean evaluation
      return Boolean(resolved && resolved !== 'false');
    } catch {
      return false;
    }
  }

  /**
   * Build dependency graph from steps
   */
  private buildDependencyGraph(steps: WorkflowStep[]): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    
    steps.forEach(step => {
      graph.set(step.id, step.depends || []);
    });
    
    return graph;
  }

  /**
   * Topological sort for dependency resolution
   */
  private topologicalSort(graph: Map<string, string[]>): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const sorted: string[] = [];

    const visit = (node: string) => {
      if (visiting.has(node)) {
        throw new Error(`Circular dependency detected involving step: ${node}`);
      }
      
      if (visited.has(node)) {
        return;
      }

      visiting.add(node);
      
      const dependencies = graph.get(node) || [];
      dependencies.forEach(dep => {
        if (!graph.has(dep)) {
          throw new Error(`Step dependency not found: ${dep} required by ${node}`);
        }
        visit(dep);
      });
      
      visiting.delete(node);
      visited.add(node);
      sorted.push(node);
    };

    Array.from(graph.keys()).forEach(visit);
    return sorted;
  }

  /**
   * Group steps that can be executed in parallel
   */
  private groupParallelSteps(sortedSteps: string[], graph: Map<string, string[]>): string[][] {
    const groups: string[][] = [];
    const completed = new Set<string>();

    while (completed.size < sortedSteps.length) {
      const currentGroup: string[] = [];
      
      sortedSteps.forEach(step => {
        if (completed.has(step)) return;
        
        const dependencies = graph.get(step) || [];
        const dependenciesMet = dependencies.every(dep => completed.has(dep));
        
        if (dependenciesMet) {
          currentGroup.push(step);
        }
      });

      if (currentGroup.length === 0) {
        throw new Error('Deadlock detected in workflow dependencies');
      }

      groups.push(currentGroup);
      currentGroup.forEach(step => completed.add(step));
    }

    return groups;
  }

  /**
   * Perform rollback operations
   */
  private async performRollback(execution: WorkflowExecution): Promise<void> {
    console.log(`Performing rollback for workflow: ${execution.workflow.name}`);
    
    const rollbackSteps = execution.workflow.errorHandling?.rollbackSteps || [];
    
    for (const stepId of rollbackSteps.reverse()) {
      try {
        await this.executeStep(execution, stepId);
        console.log(`Rollback step completed: ${stepId}`);
      } catch (error) {
        console.error(`Rollback step failed: ${stepId} - ${error}`);
      }
    }
  }

  /**
   * Get execution status
   */
  getExecution(executionId: string): WorkflowExecution | undefined {
    return this.executions.get(executionId);
  }

  /**
   * Cancel running workflow
   */
  cancelExecution(executionId: string): boolean {
    const execution = this.executions.get(executionId);
    if (execution && execution.status === 'running') {
      execution.status = 'cancelled';
      execution.endTime = Date.now();
      return true;
    }
    return false;
  }

  /**
   * Clear completed executions to free memory
   */
  clearCompletedExecutions(): number {
    let cleared = 0;
    for (const [id, execution] of this.executions) {
      if (execution.status !== 'running') {
        this.executions.delete(id);
        cleared++;
      }
    }
    return cleared;
  }
}

// Global workflow engine instance
export const workflowEngine = new WorkflowEngine();