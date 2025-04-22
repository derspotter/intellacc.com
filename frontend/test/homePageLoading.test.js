import { describe, it, expect, vi } from 'vitest'; // Assuming Vitest or Jest syntax
import van from 'vanjs-core';
import Router from '../src/router/index';
import predictionsStore from '../src/store/predictions';
import { currentPageState } from '../src/store/index';

// Mock the predictionsStore actions to check if they are called
vi.spyOn(predictionsStore.actions, 'fetchPredictions');
vi.spyOn(predictionsStore.actions, 'fetchAssignedPredictions');
vi.spyOn(predictionsStore.actions, 'fetchBettingStats');

describe('Home Page Loading', () => {
  it('should not load predictions or assigned predictions components or data on the home page', async () => {
    // Simulate navigating to the home page by setting the state
    currentPageState.val = 'home';

    // Render the Router component for the current page
    const HomePageComponent = Router();
    // Call the component function to get the actual DOM element(s)
    const homePageElement = HomePageComponent();

    // Assert that the predictions fetching actions were not called
    expect(predictionsStore.actions.fetchPredictions).not.toHaveBeenCalled();
    expect(predictionsStore.actions.fetchAssignedPredictions).not.toHaveBeenCalled();
    expect(predictionsStore.actions.fetchBettingStats).not.toHaveBeenCalled();

    // Optional: Further assertions could check the content of homePageElement
    // to ensure no prediction-related elements are present.
    // For example, checking for specific class names or text content.
  });
});